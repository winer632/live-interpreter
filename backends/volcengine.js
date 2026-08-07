/**
 * 火山引擎 同声传译 AST 2.0 后端
 *
 *   wss://openspeech.bytedance.com/api/v4/ast/v2/translate
 *
 * 协议要点（来自官方 protos.tar.gz 与 ast_python_client 示例）：
 *   · WebSocket 消息体就是裸 protobuf，**没有**火山老 ASR/TTS 那套四字节帧头
 *   · 请求 data.speech.ast.TranslateRequest，响应 data.speech.ast.TranslateResponse
 *   · 鉴权走 HTTP 请求头，新版控制台只需 X-Api-Key + X-Api-Resource-Id
 *
 * 两个语言对的实现方式不同，因为火山只给了中英一个反转值：
 *
 *   中英 zhen —— **一条**会话。source_language 和 target_language 同时传 `zhen`
 *                （官方称"中英反转互译"，示例：`你好，everyone` → `Hello，大家`），
 *                方向由模型自己处理，还能应付一句话里中英混杂。
 *
 *   中日 zhja —— 没有 `zhja` 这种值，只能开**两条**会话（zh→ja 和 ja→zh），
 *                同一路音频喂给两条，再靠 DirectionRouter 放行其中一条。
 *                实测发现 ASR 并不强制按声明的源语种识别：喂中文时两条会话都
 *                如实转写出中文，其中 ja→zh 那条因为源语种==目标语种而原样透传。
 *                所以判别信号很干净 —— 只看 ja→zh 那条的原文有没有假名：
 *                有假名说明在说日语，没有说明在说中文。
 *
 * 另外，中日只能走**声音复刻模式**（不传 speaker_id）：文档规定 s2s 指定音色模式
 * 下"目标语种必须为中英"，传了 speaker_id 就没法输出日语了。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import protobuf from 'protobufjs';
import { WebSocket } from 'ws';
import {
  DirectionRouter, LineBuilder, PAIRS, pcmDurationMs, mergeText, buildCorpus, applyCorrections,
} from './common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = path.join(__dirname, '..', 'protos');
const ENDPOINT = 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate';

export const INPUT_RATE = 16000;   // 源音频固定 16kHz 16bit 单声道
export const OUTPUT_RATE = 24000;  // 译音要 PCM，浏览器可直接播

// ---------------------------------------------------------------- protobuf

let TranslateRequest;
let TranslateResponse;

function loadProto() {
  if (TranslateRequest) return;
  const root = new protobuf.Root();
  root.resolvePath = (_origin, target) => path.resolve(PROTO_DIR, target);
  root.loadSync('products/understanding/ast/ast_service.proto', { keepCase: true });
  TranslateRequest = root.lookupType('data.speech.ast.TranslateRequest');
  TranslateResponse = root.lookupType('data.speech.ast.TranslateResponse');
}

// 事件号取自 events.proto，写成常量便于阅读
const E = {
  StartSession: 100,
  FinishSession: 102,
  TaskRequest: 200,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  UsageResponse: 154,
  AudioMuted: 250,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
  SourceSubtitleStart: 650,
  SourceSubtitleResponse: 651,
  SourceSubtitleEnd: 652,
  TranslationSubtitleStart: 653,
  TranslationSubtitleResponse: 654,
  TranslationSubtitleEnd: 655,
};

/** 每个语言对需要开哪些上游会话 */
function planSessions(pair) {
  if (pair.id === 'zhja') {
    return [
      { src: 'zh', dst: 'ja', dir: 'zh2ja', routes: false, mode: 's2s' },
      // 这条的原文转写是判方向的唯一依据：有假名=在说日语
      { src: 'ja', dst: 'zh', dir: 'ja2zh', routes: true, mode: 's2s' },
    ];
  }
  if (pair.id === 'yuezh') {
    // 单向、且只能出字幕：实测 s2s 的 volc_tob-yue-CN2zh-s2s 模型不存在，
    // 只有 s2t 可用；反向 zh→yue-CN 两种模式都不存在，做不了。
    // 方向固定，不需要判别（普通话和粤语都是汉字，本来也判不了）。
    return [{ src: 'yue-CN', dst: 'zh', dir: 'yue2zh', routes: false, mode: 's2t' }];
  }
  // 中英：一条会话包办双向，方向由它自己的原文转写判定
  return [{ src: 'zhen', dst: 'zhen', dir: null, routes: true, mode: 's2s' }];
}

// ------------------------------------------------------------------ 后端

export class VolcengineBackend {
  /**
   * @param {object} o
   * @param {string} o.apiKey        新版控制台 API Key
   * @param {string} o.resourceId    固定 volc.service_type.10053
   * @param {string} [o.appKey]      旧版控制台 App Id
   * @param {string} [o.accessKey]   旧版控制台 Access Token
   * @param {string} [o.pair]        zhen | zhja
   * @param {object} [o.options]     terms / speakerId / speechRate
   * @param {Function} o.emit        向浏览器发送归一化事件
   */
  constructor({ apiKey, resourceId, appKey, accessKey, pair = 'zhen', options = {}, emit }) {
    loadProto();
    this.auth = { apiKey, resourceId, appKey, accessKey };
    this.pair = PAIRS[pair] || PAIRS.zhen;
    this.options = options;
    this.emit = emit;
    this.router = new DirectionRouter(this.pair);
    // 火山负责把音听对（hot_words），写法由这一层统一规范
    this.lines = new LineBuilder(emit, {
      transform: (t) => applyCorrections(t, options.terms),
    });
    this.sessions = [];
    this.running = false;
    this.readyCount = 0;
  }

  get inputRate() { return INPUT_RATE; }

  /** 单会话（中英）时永远放行；双会话（中日）时按方向闸门放行 */
  _isActive(sess) {
    if (this.sessions.length === 1) return true;
    return this.router.active(sess.plan.dir);
  }

  // ------------------------------------------------------------ 连接

  start(agent) {
    this.running = true;
    this.agent = agent;
    // 单向语言对方向定死；双会话时先给个默认方向，否则开场谁都不放行
    if (this.pair.oneWay || this.pair.id === 'zhja') this.router.dir = this.router.forward;

    this.sessions = planSessions(this.pair).map((plan) => ({
      plan,
      ws: null,
      sessionId: null,
      started: false,
      srcAccum: '',
      pending: [],
      retries: 0,
      logId: null,
    }));
    for (const s of this.sessions) this._connect(s);
  }

  _headers() {
    const h = {
      'X-Api-Resource-Id': this.auth.resourceId || 'volc.service_type.10053',
      'X-Api-Connect-Id': crypto.randomUUID(),
    };
    // 新版控制台只要 API Key；没有则回退到旧版的 AppKey + AccessKey
    if (this.auth.apiKey) h['X-Api-Key'] = this.auth.apiKey;
    if (this.auth.appKey) h['X-Api-App-Key'] = this.auth.appKey;
    if (this.auth.accessKey) h['X-Api-Access-Key'] = this.auth.accessKey;
    return h;
  }

  _connect(sess) {
    sess.started = false;
    sess.sessionId = crypto.randomUUID();

    const ws = new WebSocket(ENDPOINT, {
      agent: this.agent,
      headers: this._headers(),
      maxPayload: 64 * 1024 * 1024,
    });
    ws.binaryType = 'nodebuffer';
    sess.ws = ws;

    ws.on('upgrade', (res) => { sess.logId = res.headers['x-tt-logid'] || null; });
    ws.on('open', () => this._send(sess, this._startSessionMessage(sess)));
    ws.on('message', (data) => this._onMessage(sess, data));

    ws.on('unexpected-response', (_req, res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 400);
        this.emit({
          t: 'error',
          message: this._httpHint(res.statusCode),
          detail: `HTTP ${res.statusCode} ${body}`,
          fatal: res.statusCode === 401 || res.statusCode === 403,
        });
      });
    });

    ws.on('error', (err) => {
      this.emit({ t: 'error', message: describeNetworkError(err), detail: String(err?.message || err) });
    });

    ws.on('close', () => {
      if (sess.started) this.readyCount -= 1;
      sess.started = false;
      if (!this.running) return;
      // AST 会话有时长上限，正常断开后重开一条，音频照常继续
      if (sess.retries < 8) {
        sess.retries += 1;
        setTimeout(() => this.running && this._connect(sess), Math.min(400 * sess.retries, 3000));
      } else {
        this.emit({ t: 'closed', reason: '重连次数过多' });
      }
    });
  }

  _httpHint(code) {
    if (code === 401) return 'API Key 无效或未授权（401）';
    if (code === 403) return '无权访问同声传译服务，请确认已在控制台开通（403）';
    if (code === 429) return '触发限流或额度不足（429）';
    return `火山返回 HTTP ${code}`;
  }

  // ------------------------------------------------------------ 发送

  _send(sess, obj) {
    if (sess.ws?.readyState !== WebSocket.OPEN) return;
    sess.ws.send(TranslateRequest.encode(TranslateRequest.create(obj)).finish());
  }

  _startSessionMessage(sess) {
    const o = this.options;
    const { src, dst } = sess.plan;
    const mode = sess.plan.mode || 's2s';
    const request = {
      mode,
      source_language: src,
      target_language: dst,
      enable_source_language_detect: true,
    };

    // 指定音色模式要求"目标语种必须为中英"，所以目标是日语时绝不能传 speaker_id，
    // 只能走声音复刻模式（复刻说话人音色）
    const targetIsZhEn = dst === 'zh' || dst === 'en' || dst === 'zhen';
    if (o.speakerId && targetIsZhEn) {
      request.speaker_id = o.speakerId;
      request.tts_resource_id = o.ttsResourceId || 'seed-tts-2.0';
    }
    if (typeof o.speechRate === 'number') request.speech_rate = o.speechRate;

    // 术语库：热词让模型把音听对，译音因此也念得对
    const corpus = buildCorpus(o.terms);
    if (corpus) request.corpus = corpus;

    const msg = {
      request_meta: { SessionID: sess.sessionId },
      event: E.StartSession,
      user: { uid: 'live-interpreter', did: 'mac-desktop', platform: 'web' },
      source_audio: { format: 'pcm', rate: INPUT_RATE, bits: 16, channel: 1 },
      request,
      denoise: true,
    };
    // s2t 只出文本，不需要目标音频配置
    if (mode === 's2s') {
      // 文档：pcm 在 24000Hz 下默认 32float、16000Hz 下默认 16bit。
      // 这里显式声明 16bit，同时接收端还有 float32 自动识别兜底。
      msg.target_audio = { format: 'pcm', rate: OUTPUT_RATE, bits: 16, channel: 1 };
    }
    return msg;
  }

  /** @param {string} base64 16kHz PCM16 单声道 */
  sendAudio(base64) {
    const buf = Buffer.from(base64, 'base64');
    for (const sess of this.sessions) {
      if (!sess.started) {
        // 会话尚未建立，先攒着（最多约 4 秒），避免开头掉字
        if (sess.pending.length > 100) sess.pending.shift();
        sess.pending.push(buf);
        continue;
      }
      this._sendAudioBuffer(sess, buf);
    }
  }

  _sendAudioBuffer(sess, buf) {
    this._send(sess, {
      request_meta: { SessionID: sess.sessionId },
      event: E.TaskRequest,
      source_audio: { binary_data: buf },
    });
  }

  setMode(mode) {
    this.router.setMode(mode);
    this.emit({ t: 'dir', dir: this.router.dir });
  }

  close() {
    this.running = false;
    this.lines.finalizeAll();
    this.lines.dispose();
    for (const sess of this.sessions) {
      if (sess.ws?.readyState === WebSocket.OPEN && sess.started) {
        this._send(sess, { request_meta: { SessionID: sess.sessionId }, event: E.FinishSession });
      }
      try { sess.ws?.close(); } catch {}
      sess.ws = null;
    }
    this.sessions = [];
  }

  // ------------------------------------------------------------ 接收

  _onMessage(sess, data) {
    let r;
    try {
      r = TranslateResponse.decode(data);
    } catch (err) {
      this.emit({ t: 'error', message: '无法解析火山返回的数据', detail: String(err) });
      return;
    }

    const text = r.text || '';
    const meta = r.response_meta || {};

    if (process.env.DEBUG_VOLC) {
      console.log(`[volc ${sess.plan.src}→${sess.plan.dst}] event=${r.event} data=${r.data?.length || 0}B text=${JSON.stringify(text.slice(0, 30))}`);
    }

    switch (r.event) {
      case E.SessionStarted:
        sess.started = true;
        sess.retries = 0;
        this.readyCount += 1;
        if (this.readyCount >= this.sessions.length) {
          this.emit({
            t: 'ready',
            backend: 'volcengine',
            pair: this.pair.id,
            noAudio: Boolean(this.pair.noAudio),
            inputRate: INPUT_RATE,
            logId: sess.logId,
          });
          this.emit({ t: 'dir', dir: this.router.dir });
        }
        for (const buf of sess.pending.splice(0)) this._sendAudioBuffer(sess, buf);
        break;

      case E.SourceSubtitleStart:
        sess.srcAccum = '';
        if (this._isActive(sess)) this.lines.begin('src');
        break;

      case E.SourceSubtitleResponse:
      case E.SourceSubtitleEnd: {
        if (!text) break;
        const isEnd = r.event === E.SourceSubtitleEnd;
        // 651 是增量片段，652 是整句全量
        sess.srcAccum = isEnd ? text : mergeText(sess.srcAccum, text);

        // 方向要按**整句累计文本**判，不能按单个片段判：
        // "这是我们 SensePedia 的产品经理" 里的 "SensePedia" 片段不含汉字，
        // 单看它会把整句方向判成英文。
        // 双会话时只信 routes 标记的那条（中日里是 ja→zh），它的原文有没有假名
        // 就是"在说日语还是中文"的干净信号。
        if (sess.plan.routes && this.router.observe(sess.srcAccum)) {
          this.emit({ t: 'dir', dir: this.router.dir });
        }

        if (!this._isActive(sess)) break;
        const dir = this.router.mode === 'auto' ? this.router.dir : this.router.mode;
        this.lines.update('src', dir, text, isEnd);
        if (isEnd) this.lines.end('src', dir);
        break;
      }

      case E.TranslationSubtitleStart:
        if (this._isActive(sess)) this.lines.begin('dst');
        break;

      case E.TranslationSubtitleResponse:
      case E.TranslationSubtitleEnd: {
        if (!text || !this._isActive(sess)) break;
        // 方向不在这里重新判定：译文行沿用同序号原文行已经定下的方向，
        // 避免译文比原文慢半拍时串到下一句去
        const isEnd = r.event === E.TranslationSubtitleEnd;
        this.lines.update('dst', undefined, text, isEnd);
        if (isEnd) this.lines.end('dst', undefined);
        break;
      }

      case E.TTSResponse:
      case E.TTSSentenceEnd: {
        const bytes = r.data;
        if (!bytes || !bytes.length || !this._isActive(sess)) break;
        const pcm = toPCM16Base64(bytes);
        this.router.notePlayback(pcmDurationMs(pcm, OUTPUT_RATE));
        this.emit({ t: 'audio', pcm });
        break;
      }

      case E.UsageResponse: {
        const billing = meta.Billing || meta.billing;
        if (!billing) break;
        // rpcmeta.proto 里 BillingItem 的字段是 PascalCase，统一成小写再往前端发
        const items = (billing.Items || billing.items || []).map((i) => ({
          unit: i.Unit || i.unit || '',
          quantity: Number(i.Quantity ?? i.quantity ?? 0),
        }));
        this.emit({
          t: 'usage',
          durationMs: Number(billing.DurationMsec || billing.durationMsec || 0),
          items,
        });
        break;
      }

      case E.AudioMuted:
        // VAD 判定静音，暂时不需要做什么
        break;

      case E.SessionFinished:
        this.lines.finalizeAll();
        break;

      case E.SessionFailed:
        this.emit({
          t: 'error',
          message: describeVolcCode(meta.StatusCode, meta.Message),
          detail: `${sess.plan.src}→${sess.plan.dst} status=${meta.StatusCode} logid=${sess.logId || '-'} ${meta.Message || ''}`,
          fatal: isFatalVolcCode(meta.StatusCode),
        });
        break;
    }
  }
}

// ------------------------------------------------------------ 音频归一化

/**
 * 判断一段字节是不是 float32 PCM。
 *
 * 文档说 pcm 在 24000Hz 采样率下默认 32 位浮点，显式传 bits 未必被采纳，
 * 所以这里做一层自动识别：float32 语音样本全部落在 [-1,1]；反过来把 int16
 * 语音当成 float32 解读时指数位是随机的，绝大多数会变成 1e30 量级或非规格化的
 * 极小值，因此这个判据很干净。
 */
function looksLikeFloat32(bytes) {
  if (bytes.length < 64 || bytes.length % 4 !== 0) return false;
  const ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  const f = new Float32Array(ab);
  const step = Math.max(1, Math.floor(f.length / 512));
  let checked = 0;
  let nonZero = 0;
  for (let i = 0; i < f.length; i += step) {
    const v = f[i];
    if (!Number.isFinite(v) || Math.abs(v) > 1.5) return false;
    if (v !== 0) nonZero += 1;
    checked += 1;
  }
  // 全零既像 float32 也像 int16，交给 int16 分支处理即可
  return checked > 0 && nonZero > checked * 0.02;
}

/** 统一转成 base64 的 int16 PCM，浏览器那边只认这一种 */
function toPCM16Base64(bytes) {
  if (looksLikeFloat32(bytes)) {
    const ab = new ArrayBuffer(bytes.length);
    new Uint8Array(ab).set(bytes);
    const f = new Float32Array(ab);
    const i16 = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return Buffer.from(i16.buffer).toString('base64');
  }
  return Buffer.from(bytes).toString('base64');
}

// ------------------------------------------------------------ 错误映射

function describeVolcCode(code, message) {
  switch (Number(code)) {
    case 45000001: return '请求参数无效（缺字段/值不合法/重复请求）';
    case 45000002: return '空音频';
    case 45000081: return '等包超时：音频流中断太久';
    case 45000151: return '音频格式不正确';
    case 55000031: return '服务器繁忙，请稍后重试';
    default:
      if (String(code).startsWith('550')) return `火山服务内部错误（${code}）`;
      return message || `火山会话失败（${code}）`;
  }
}

function isFatalVolcCode(code) {
  return [45000001, 45000151].includes(Number(code));
}

export function describeNetworkError(err) {
  const code = err?.code || '';
  if (code === 'ENOTFOUND') return 'DNS 解析失败：无法解析 openspeech.bytedance.com';
  if (code === 'ECONNREFUSED') return '连接被拒绝';
  if (code === 'ETIMEDOUT') return '连接超时';
  return `网络错误：${err?.message || err}`;
}

// ------------------------------------------------------------ 连通性自检

export async function testVolcengine(auth, agent, timeoutMs = 12000) {
  loadProto();
  if (!auth.apiKey && !auth.appKey) {
    return { ok: false, stage: 'key', message: '尚未配置火山 API Key' };
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(r);
    };

    const timer = setTimeout(
      () => done({ ok: false, stage: 'timeout', message: `连接超时（${timeoutMs / 1000}s）` }),
      timeoutMs,
    );

    const backend = new VolcengineBackend({ ...auth, emit: () => {} });
    const probe = { plan: { src: 'zhen', dst: 'zhen' }, sessionId: crypto.randomUUID(), ws: null };
    const ws = new WebSocket(ENDPOINT, { agent, headers: backend._headers() });
    ws.binaryType = 'nodebuffer';
    probe.ws = ws;
    let logId = null;

    ws.on('upgrade', (res) => { logId = res.headers['x-tt-logid'] || null; });
    ws.on('open', () => backend._send(probe, backend._startSessionMessage(probe)));

    ws.on('message', (data) => {
      let r;
      try { r = TranslateResponse.decode(data); } catch { return; }
      const meta = r.response_meta || {};
      if (r.event === E.SessionStarted) {
        done({ ok: true, stage: 'open', message: '连接成功，同声传译服务可用', logId });
      } else if (r.event === E.SessionFailed) {
        done({
          ok: false,
          stage: 'session',
          message: describeVolcCode(meta.StatusCode, meta.Message),
          detail: `status=${meta.StatusCode} logid=${logId || '-'}`,
        });
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({
        ok: false,
        stage: 'http',
        message: backend._httpHint(res.statusCode),
        detail: Buffer.concat(chunks).toString('utf8').slice(0, 300),
      }));
    });

    ws.on('error', (err) => done({ ok: false, stage: 'network', message: describeNetworkError(err) }));
  });
}

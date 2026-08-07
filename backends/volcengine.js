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
 * 中英双向只需要**一条**会话：source_language 和 target_language 同时传 `zhen`
 * （官方称"中英反转互译"，示例：`你好，everyone` → `Hello，大家`）。
 * 这比 OpenAI 那边开两条会话省一半钱，还能处理一句话里中英混杂的情况。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import protobuf from 'protobufjs';
import { WebSocket } from 'ws';
import { DirectionRouter, LineBuilder, pcmDurationMs } from './common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = path.join(__dirname, '..', 'protos');
const ENDPOINT = 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate';

export const INPUT_RATE = 16000;   // 源音频固定 16kHz 16bit 单声道
export const OUTPUT_RATE = 24000;  // 译音我们要 PCM，浏览器可直接播

// ---------------------------------------------------------------- protobuf

let TranslateRequest;
let TranslateResponse;
let EV;

function loadProto() {
  if (TranslateRequest) return;
  const root = new protobuf.Root();
  root.resolvePath = (_origin, target) => path.resolve(PROTO_DIR, target);
  root.loadSync('products/understanding/ast/ast_service.proto', { keepCase: true });
  TranslateRequest = root.lookupType('data.speech.ast.TranslateRequest');
  TranslateResponse = root.lookupType('data.speech.ast.TranslateResponse');
  EV = root.lookupEnum('data.speech.event.Type').values;
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

// ------------------------------------------------------------------ 后端

export class VolcengineBackend {
  /**
   * @param {object} o
   * @param {string} o.apiKey        新版控制台 API Key
   * @param {string} o.resourceId    固定 volc.service_type.10053
   * @param {string} [o.appKey]      旧版控制台 App Id
   * @param {string} [o.accessKey]   旧版控制台 Access Token
   * @param {object} [o.options]     speakerId / speechRate / hotWords / glossary
   * @param {Function} o.emit        向浏览器发送归一化事件
   */
  constructor({ apiKey, resourceId, appKey, accessKey, options = {}, emit }) {
    loadProto();
    this.auth = { apiKey, resourceId, appKey, accessKey };
    this.options = options;
    this.emit = emit;
    this.router = new DirectionRouter();
    this.lines = new LineBuilder(emit);
    this.ws = null;
    this.sessionId = null;
    this.running = false;
    this.started = false;
    this.pending = [];
    this.retries = 0;
  }

  get inputRate() { return INPUT_RATE; }

  // ------------------------------------------------------------ 连接

  start(agent) {
    this.running = true;
    this.agent = agent;
    this._connect();
  }

  _headers() {
    const connectId = crypto.randomUUID();
    // 新版控制台只要 API Key；没有则回退到旧版的 AppKey + AccessKey
    const h = {
      'X-Api-Resource-Id': this.auth.resourceId || 'volc.service_type.10053',
      'X-Api-Connect-Id': connectId,
    };
    if (this.auth.apiKey) h['X-Api-Key'] = this.auth.apiKey;
    if (this.auth.appKey) h['X-Api-App-Key'] = this.auth.appKey;
    if (this.auth.accessKey) h['X-Api-Access-Key'] = this.auth.accessKey;
    return h;
  }

  _connect() {
    this.started = false;
    this.sessionId = crypto.randomUUID();

    this.ws = new WebSocket(ENDPOINT, {
      agent: this.agent,
      headers: this._headers(),
      maxPayload: 64 * 1024 * 1024,
    });
    this.ws.binaryType = 'nodebuffer';

    this.ws.on('open', () => {
      this.logId = null;
      this._send(this._startSessionMessage());
    });

    this.ws.on('upgrade', (res) => {
      this.logId = res.headers['x-tt-logid'] || null;
    });

    this.ws.on('message', (data) => this._onMessage(data));

    this.ws.on('unexpected-response', (_req, res) => {
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

    this.ws.on('error', (err) => {
      this.emit({ t: 'error', message: describeNetworkError(err), detail: String(err?.message || err) });
    });

    this.ws.on('close', () => {
      this.started = false;
      if (!this.running) return;
      // AST 会话有时长上限，正常断开后重开一条，音频照常继续
      if (this.retries < 8) {
        this.retries += 1;
        setTimeout(() => this.running && this._connect(), Math.min(400 * this.retries, 3000));
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

  _send(obj) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const msg = TranslateRequest.create(obj);
    this.ws.send(TranslateRequest.encode(msg).finish());
  }

  _startSessionMessage() {
    const o = this.options;
    const request = {
      mode: 's2s',
      // zhen = 中英反转互译：一条会话同时处理两个方向
      source_language: o.sourceLanguage || 'zhen',
      target_language: o.targetLanguage || 'zhen',
      enable_source_language_detect: true,
    };
    if (o.speakerId) {
      request.speaker_id = o.speakerId;
      // 走精品/复刻音色链路时必须带 tts_resource_id
      request.tts_resource_id = o.ttsResourceId || 'seed-tts-2.0';
    }
    if (typeof o.speechRate === 'number') request.speech_rate = o.speechRate;
    if (o.hotWords?.length || o.glossary) {
      request.corpus = {};
      if (o.hotWords?.length) request.corpus.hot_words_list = o.hotWords;
      if (o.glossary) request.corpus.glossary_list = o.glossary;
    }

    return {
      request_meta: { SessionID: this.sessionId },
      event: E.StartSession,
      user: { uid: 'live-interpreter', did: 'mac-desktop', platform: 'web' },
      source_audio: { format: 'pcm', rate: INPUT_RATE, bits: 16, channel: 1 },
      // bits/channel 必须显式指定：只给 format 和 rate 时，服务端返回的是
      // float32 PCM，按 int16 解读就是一片噪声
      target_audio: { format: 'pcm', rate: OUTPUT_RATE, bits: 16, channel: 1 },
      request,
      denoise: true,
    };
  }

  /** @param {string} base64 16kHz PCM16 单声道 */
  sendAudio(base64) {
    const buf = Buffer.from(base64, 'base64');
    if (!this.started) {
      // 会话尚未建立，先攒着（最多约 4 秒），避免开头掉字
      if (this.pending.length > 100) this.pending.shift();
      this.pending.push(buf);
      return;
    }
    this._sendAudioBuffer(buf);
  }

  _sendAudioBuffer(buf) {
    this._send({
      request_meta: { SessionID: this.sessionId },
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
    if (this.ws?.readyState === WebSocket.OPEN && this.started) {
      this._send({ request_meta: { SessionID: this.sessionId }, event: E.FinishSession });
    }
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }

  // ------------------------------------------------------------ 接收

  _onMessage(data) {
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
      console.log(`[volc] event=${r.event} data=${r.data?.length || 0}B text=${JSON.stringify(text.slice(0, 30))}`);
    }

    switch (r.event) {
      case E.SessionStarted:
        this.started = true;
        this.retries = 0;
        this.emit({ t: 'ready', backend: 'volcengine', inputRate: INPUT_RATE, logId: this.logId });
        for (const buf of this.pending.splice(0)) this._sendAudioBuffer(buf);
        break;

      case E.SourceSubtitleStart:
        this.lines.begin('src');
        break;

      case E.SourceSubtitleResponse:
      case E.SourceSubtitleEnd: {
        if (!text) break;
        // 原文语种决定这一句的排版方向
        if (this.router.observe(text)) this.emit({ t: 'dir', dir: this.router.dir });
        const dir = this.router.mode === 'auto' ? this.router.dir : this.router.mode;
        // 651 是增量片段，652 是整句全量
        const isEnd = r.event === E.SourceSubtitleEnd;
        this.lines.update('src', dir, text, isEnd);
        if (isEnd) this.lines.end('src', dir);
        break;
      }

      case E.TranslationSubtitleStart:
        this.lines.begin('dst');
        break;

      case E.TranslationSubtitleResponse:
      case E.TranslationSubtitleEnd: {
        if (!text) break;
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
        if (!bytes || !bytes.length) break;
        const pcm = toPCM16Base64(bytes);
        this.router.notePlayback(pcmDurationMs(pcm, OUTPUT_RATE));
        this.emit({ t: 'audio', pcm });
        break;
      }

      case E.UsageResponse: {
        const billing = meta.Billing || meta.billing;
        if (!billing) break;
        // rpcmeta.proto 里 BillingItem 的字段是 PascalCase，这里统一成小写再往前端发
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
          detail: `status=${meta.StatusCode} logid=${this.logId || '-'} ${meta.Message || ''}`,
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
 * float32 语音样本全部落在 [-1,1]；反过来，把 int16 语音当成 float32 解读时，
 * 指数位是随机的，绝大多数会变成 1e30 量级或非规格化的极小值，因此这个判据
 * 很干净。
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
    const ws = new WebSocket(ENDPOINT, { agent, headers: backend._headers() });
    ws.binaryType = 'nodebuffer';
    let logId = null;

    ws.on('upgrade', (res) => { logId = res.headers['x-tt-logid'] || null; });

    ws.on('open', () => {
      backend.ws = ws;
      backend.sessionId = crypto.randomUUID();
      backend._send(backend._startSessionMessage());
    });

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

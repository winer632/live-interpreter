/**
 * OpenAI gpt-realtime-translate 后端
 *
 *   wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate
 *
 * 这个端点只接受"目标语言"，源语言由模型自动识别，而且没有 turn detection ——
 * 它是持续边听边译的流。所以双向传译需要**两条**会话：
 *
 *   会话 EN (output.language = "en")  中文 → 英文
 *   会话 ZH (output.language = "zh")  英文 → 中文
 *
 * 同一支麦克风的音频同时喂给两条会话，靠 DirectionRouter 决定放行哪一条：
 * 你说中文时 ZH 那条会把中文再"翻译"成中文原样播出来，必须挡掉。
 */

import { WebSocket } from 'ws';
import { DirectionRouter, LineBuilder, pcmDurationMs } from './common.js';

export const INPUT_RATE = 24000;
export const OUTPUT_RATE = 24000;

const MODEL = process.env.OPENAI_TRANSLATE_MODEL || 'gpt-realtime-translate';
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-realtime-whisper';
const ENDPOINT = `wss://api.openai.com/v1/realtime/translations?model=${encodeURIComponent(MODEL)}`;

function sessionUpdate(targetLang) {
  return {
    type: 'session.update',
    session: {
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          // 输入转写是方向路由的唯一依据，必须开启
          transcription: { model: TRANSCRIBE_MODEL },
        },
        output: { language: targetLang },
      },
    },
  };
}

export class OpenAIBackend {
  constructor({ apiKey, emit }) {
    this.apiKey = apiKey;
    this.emit = emit;
    this.router = new DirectionRouter();
    this.lines = new LineBuilder(emit);
    this.sessions = {};
    this.running = false;
  }

  get inputRate() { return INPUT_RATE; }

  start(agent) {
    this.running = true;
    this.agent = agent;
    this.readyCount = 0;
    for (const lang of ['en', 'zh']) {
      this.sessions[lang] = this._openSession(lang);
    }
  }

  _openSession(outLang) {
    const dir = outLang === 'en' ? 'zh2en' : 'en2zh';
    const s = { outLang, dir, ws: null, ready: false, retries: 0, fatal: false };

    const connect = () => {
      s.ws = new WebSocket(ENDPOINT, {
        agent: this.agent,
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      s.ws.on('open', () => {
        s.ws.send(JSON.stringify(sessionUpdate(outLang)));
        s.ready = true;
        s.retries = 0;
        this.readyCount += 1;
        if (this.readyCount >= 2) {
          this.emit({ t: 'ready', backend: 'openai', inputRate: INPUT_RATE });
        }
      });

      s.ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        this._onEvent(s, msg);
      });

      s.ws.on('unexpected-response', (_req, res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          s.fatal = res.statusCode === 401 || res.statusCode === 403;
          this.emit({
            t: 'error',
            message: httpHint(res.statusCode),
            detail: Buffer.concat(chunks).toString('utf8').slice(0, 300),
            fatal: s.fatal,
          });
        });
      });

      s.ws.on('error', (err) => {
        this.emit({ t: 'error', message: describeNetworkError(err), detail: String(err?.message || err) });
      });

      s.ws.on('close', () => {
        if (s.ready) this.readyCount -= 1;
        s.ready = false;
        if (!this.running || s.fatal) return;
        if (s.retries < 5) {
          s.retries += 1;
          setTimeout(() => this.running && !s.fatal && connect(), 500 * s.retries);
        }
      });
    };

    connect();
    return s;
  }

  _onEvent(s, msg) {
    switch (msg.type) {
      // 源语言转写：既是字幕原文，也是判定方向的依据
      case 'session.input_transcript.delta': {
        if (!msg.delta) break;
        // 先判方向，再决定这条会话是否放行 —— 顺序不能反
        if (this.router.observe(msg.delta)) {
          this.lines.advanceOnDirectionChange();
          this.emit({ t: 'dir', dir: this.router.dir });
        }
        if (!this.router.active(s.dir)) break;
        this.lines.update('src', s.dir, msg.delta);
        break;
      }

      case 'session.output_transcript.delta': {
        if (!msg.delta || !this.router.active(s.dir)) break;
        this.lines.update('dst', s.dir, msg.delta);
        break;
      }

      case 'session.output_audio.delta': {
        if (!msg.delta || !this.router.active(s.dir)) break;
        this.router.notePlayback(pcmDurationMs(msg.delta, OUTPUT_RATE));
        this.emit({ t: 'audio', pcm: msg.delta });
        break;
      }

      case 'error':
        this.emit({
          t: 'error',
          message: msg.error?.message || 'OpenAI 返回错误',
          detail: JSON.stringify(msg.error || {}),
          fatal: /api_key|quota/i.test(msg.error?.code || ''),
        });
        break;
    }
  }

  /** @param {string} base64 24kHz PCM16 单声道 */
  sendAudio(base64) {
    const payload = JSON.stringify({ type: 'session.input_audio_buffer.append', audio: base64 });
    for (const lang of ['en', 'zh']) {
      const s = this.sessions[lang];
      if (s?.ws?.readyState === WebSocket.OPEN) s.ws.send(payload);
    }
  }

  setMode(mode) {
    this.router.setMode(mode);
    this.lines.advanceOnDirectionChange();
    this.emit({ t: 'dir', dir: this.router.dir });
  }

  close() {
    this.running = false;
    this.lines.finalizeAll();
    this.lines.dispose();
    for (const lang of ['en', 'zh']) {
      try { this.sessions[lang]?.ws?.close(); } catch {}
    }
    this.sessions = {};
  }
}

function httpHint(code) {
  if (code === 401) return 'OpenAI API Key 无效或未授权（401）';
  if (code === 403) return '无权访问该模型（403）';
  if (code === 429) return '额度不足或触发限流，请检查账户余额（429）';
  return `OpenAI 返回 HTTP ${code}`;
}

export function describeNetworkError(err) {
  const code = err?.code || '';
  if (code === 'ENOTFOUND') return 'DNS 解析失败：无法解析 api.openai.com。请检查网络或配置代理。';
  if (code === 'ECONNREFUSED') return '连接被拒绝。若使用代理，请确认代理端口正确且已启动。';
  if (code === 'ETIMEDOUT') return '连接超时：网络无法直达 api.openai.com，需要配置代理。';
  if (String(code).includes('CERT')) return 'TLS 证书校验失败，可能被中间设备拦截。';
  return `网络错误：${err?.message || err}`;
}

/** 连通性自检：握手成功不代表 Key 有效，要等上游推第一条消息 */
export async function testOpenAI(apiKey, agent, timeoutMs = 12000) {
  if (!apiKey) return { ok: false, stage: 'key', message: '尚未配置 OpenAI API Key' };

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
      () => done({ ok: false, stage: 'timeout', message: `连接超时（${timeoutMs / 1000}s）。通常是网络无法访问 api.openai.com，或代理不支持 WebSocket。` }),
      timeoutMs,
    );

    const ws = new WebSocket(ENDPOINT, { agent, headers: { Authorization: `Bearer ${apiKey}` } });

    ws.on('open', () => {
      ws.send(JSON.stringify(sessionUpdate('en')));
      setTimeout(() => done({ ok: true, stage: 'open', message: `连接成功，Key 有效，模型 ${MODEL} 可用` }), 2500);
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type !== 'error') return;
      const code = msg.error?.code || '';
      const hint =
        code === 'invalid_api_key' ? 'API Key 无效，请检查是否复制完整' :
        code === 'insufficient_quota' ? '账户余额不足，请到 platform.openai.com 充值' :
        msg.error?.message || '上游返回错误';
      done({ ok: false, stage: 'auth', message: hint, detail: msg.error?.message || '' });
    });

    ws.on('unexpected-response', (_req, res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({
        ok: false,
        stage: 'http',
        message: httpHint(res.statusCode),
        detail: Buffer.concat(chunks).toString('utf8').slice(0, 300),
      }));
    });

    ws.on('error', (err) => done({ ok: false, stage: 'network', message: describeNetworkError(err), detail: String(err?.message || err) }));
  });
}

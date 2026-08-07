/**
 * 演示后端 —— 不需要任何 API Key，也不消耗额度
 *
 * 用一段预置的中英对话把整条链路走一遍：WebSocket 管道、方向切换、分句成行、
 * 字幕渲染、译音播放。译音是合成音，中文 660Hz、英文 440Hz，方便凭音高判断
 * 当前放的是哪个方向。
 */

import { LineBuilder } from './common.js';

export const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;

const SCRIPT = [
  { dir: 'zh2en', src: '王先生您好，非常感谢您今天专程过来。', dst: 'Hello, thank you very much for making the trip here today.' },
  { dir: 'en2zh', src: 'My pleasure. Could you walk me through the pricing model first?', dst: '很荣幸。能先给我讲一下你们的定价模式吗？' },
  { dir: 'zh2en', src: '当然可以。我们按月订阅，基础版每个席位五十美元。', dst: 'Of course. We charge a monthly subscription, fifty dollars per seat for the basic tier.' },
  { dir: 'en2zh', src: 'That sounds reasonable. What about enterprise deployment and data security?', dst: '听起来挺合理。那企业部署和数据安全方面呢？' },
  { dir: 'zh2en', src: '数据全部私有化部署，这个 pipeline 的 latency 我们也做了优化。', dst: 'All data is deployed on-premises, and we have also optimised the latency of this pipeline.' },
];

const UTT_MS = 9000;
const TALK_MS = 4800;

/** 生成一段连续相位的正弦音，返回 base64 PCM16 */
function toneChunk(freq, sampleIndex, samples, sr = OUTPUT_RATE) {
  const i16 = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = (sampleIndex + i) / sr;
    const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3.2 * t);
    i16[i] = Math.round(0.16 * 32767 * syllable * Math.sin(2 * Math.PI * freq * t));
  }
  return Buffer.from(i16.buffer).toString('base64');
}

export class MockBackend {
  constructor({ emit }) {
    this.emit = emit;
    this.lines = new LineBuilder(emit);
    this.timers = new Set();
    this.mode = 'auto';
  }

  get inputRate() { return INPUT_RATE; }

  _at(ms, fn) {
    const id = setTimeout(() => { this.timers.delete(id); fn(); }, ms);
    this.timers.add(id);
  }

  /** 把一段文本在 [from, from+span] 区间内逐字吐出，模拟流式转写 */
  _stream(text, which, dir, from, span) {
    const pieces = text.match(/.{1,3}/g) || [];
    const step = span / Math.max(1, pieces.length);
    let acc = '';
    pieces.forEach((p, i) => {
      acc += p;
      const snapshot = acc;
      this._at(from + i * step, () => this.lines.update(which, dir, snapshot));
    });
  }

  start() {
    this.emit({ t: 'ready', backend: 'mock', pair: 'zhen', inputRate: INPUT_RATE });

    SCRIPT.forEach((utt, idx) => {
      const t0 = idx * UTT_MS + 700;

      this._at(t0 - 50, () => {
        this.lines.begin('src');
        this.lines.begin('dst');
        this.emit({ t: 'dir', dir: utt.dir });
      });

      this._stream(utt.src, 'src', utt.dir, t0, TALK_MS);
      this._stream(utt.dst, 'dst', utt.dir, t0 + 800, TALK_MS);

      this._at(t0 + TALK_MS + 900, () => {
        this.lines.end('src', utt.dir);
        this.lines.end('dst', utt.dir);
      });

      // 译音：200ms 一包，与真实后端一致
      const freq = utt.dir === 'zh2en' ? 440 : 660;
      const chunk = OUTPUT_RATE * 0.2;
      const n = Math.round(TALK_MS / 200);
      for (let c = 0; c < n; c++) {
        this._at(t0 + 800 + c * 200, () => this.emit({ t: 'audio', pcm: toneChunk(freq, c * chunk, chunk) }));
      }
    });

    this._at(SCRIPT.length * UTT_MS + 1500, () => {
      this.lines.finalizeAll();
      this.emit({ t: 'closed', reason: '演示脚本播放完毕' });
    });
  }

  sendAudio() { /* 演示模式忽略真实麦克风输入 */ }

  setMode(mode) {
    this.mode = mode;
  }

  close() {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.lines.dispose();
  }
}

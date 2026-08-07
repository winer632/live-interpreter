/**
 * 真实链路验证（会消耗少量额度，约几分钱）
 *
 * 用 macOS 内置的 `say` 合成一段语音，按实时速率喂进本地服务，
 * 检验：音频格式被接受 → 出原文字幕 → 出译文字幕 → 出译音。
 * 返回的译音会存成 wav，可以直接播来听。
 *
 *   npm start                      # 另开终端，用真实后端启动
 *   node test-live.mjs             # 默认跑中文
 *   node test-live.mjs en          # 跑英文
 */

import { WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LANG = process.argv[2] === 'en' ? 'en' : 'zh';
const CASES = {
  zh: { voice: 'Tingting', text: '王先生您好，非常感谢您今天专程过来。我们先介绍一下公司的基本情况，然后再谈合作细节。' },
  en: { voice: 'Samantha', text: 'Thank you for having me. Could you walk me through the pricing model and the enterprise deployment options first?' },
};
const voice = CASES[LANG].voice;
// 允许覆盖文本：node test-live.mjs zh "这是我们 SensePedia 的产品经理"
const text = process.argv[3] || CASES[LANG].text;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'interp-'));
const aiff = path.join(tmp, 'in.aiff');
const wav = path.join(tmp, 'in.wav');

console.log(`合成${LANG === 'zh' ? '中文' : '英文'}语音（${voice}）：${text}\n`);
execFileSync('say', ['-v', voice, '-o', aiff, text]);
// AST 要求 16kHz / 16bit / 单声道
execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);

/** 从 wav 中取出裸 PCM 数据段 */
function pcmFromWav(file) {
  const b = fs.readFileSync(file);
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') return b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error('wav 里找不到 data 段');
}

const pcm = pcmFromWav(wav);
const FRAME = 16000 * 0.08 * 2; // 80ms @16kHz 16bit
console.log(`音频 ${(pcm.length / 2 / 16000).toFixed(1)}s，共 ${Math.ceil(pcm.length / FRAME)} 包\n`);

const lines = new Map();
const outAudio = [];
let ready = null;
let firstAudioAt = null;
const t0 = Date.now();

const ws = new WebSocket('ws://localhost:5173/ws');

ws.on('error', (e) => {
  console.error('连接失败：', e.message, '\n请先在另一个终端运行 npm start');
  process.exit(1);
});

ws.on('open', () => console.log('已连接本地服务，等待上游会话建立…'));

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  switch (m.t) {
    case 'ready':
      ready = m;
      console.log(`✅ 上游就绪 · 后端 ${m.backend} · 输入 ${m.inputRate}Hz\n`);
      stream();
      break;
    case 'dir':
      console.log(`   [方向] ${m.dir}`);
      break;
    case 'line': {
      lines.set(m.id, m);
      const tag = m.final ? '完结' : '进行';
      console.log(`   [${tag}#${m.id}] 原文: ${m.src || '…'}\n            译文: ${m.dst || '…'}`);
      break;
    }
    case 'audio':
      if (!firstAudioAt) {
        firstAudioAt = Date.now() - t0;
        console.log(`   [译音] 首包到达，距开始 ${firstAudioAt}ms`);
      }
      outAudio.push(Buffer.from(m.pcm, 'base64'));
      break;
    case 'usage':
      console.log(`   [计费] 音频时长 ${m.durationMs}ms  items=${JSON.stringify(m.items)}`);
      break;
    case 'error':
      console.error(`❌ ${m.message}`, m.detail || '');
      if (m.fatal) finish(1);
      break;
    case 'closed':
      finish(0);
      break;
  }
});

async function stream() {
  for (let off = 0; off < pcm.length; off += FRAME) {
    ws.send(JSON.stringify({ t: 'audio', pcm: pcm.subarray(off, off + FRAME).toString('base64') }));
    await new Promise((r) => setTimeout(r, 80)); // 按实时速率发送
  }
  console.log('\n音频发送完毕，等待尾部译文…（8 秒）');
  // 继续送静音，避免上游判定等包超时
  const silence = Buffer.alloc(FRAME).toString('base64');
  for (let i = 0; i < 100; i++) {
    ws.send(JSON.stringify({ t: 'audio', pcm: silence }));
    await new Promise((r) => setTimeout(r, 80));
  }
  finish(0);
}

let done = false;
function finish(code) {
  if (done) return;
  done = true;
  try { ws.close(); } catch {}

  console.log('\n=========== 结果 ===========\n');
  const got = [...lines.values()].sort((a, b) => a.id - b.id);
  for (const l of got) {
    console.log(`[${l.dir}]`);
    console.log(`  原文  ${l.src}`);
    console.log(`  译文  ${l.dst}\n`);
  }

  let ok = true;
  const check = (c, label) => { console.log(`${c ? '✅' : '❌'} ${label}`); if (!c) ok = false; };
  check(Boolean(ready), '上游会话建立');
  check(got.length > 0, `产出字幕 ${got.length} 句`);
  check(got.some((l) => l.src?.trim()), '有原文');
  check(got.some((l) => l.dst?.trim()), '有译文');
  check(outAudio.length > 0, `收到译音 ${outAudio.length} 包`);

  if (outAudio.length) {
    const data = Buffer.concat(outAudio);
    const out = path.resolve(`translated-${LANG}.wav`);
    fs.writeFileSync(out, wavHeader(data.length, 24000).length ? Buffer.concat([wavHeader(data.length, 24000), data]) : data);
    console.log(`\n译音已保存：${out}  (${(data.length / 2 / 24000).toFixed(1)}s)`);
    console.log(`播放：  afplay ${out}`);
    if (firstAudioAt) console.log(`首包延迟：${firstAudioAt}ms`);
  }

  console.log(`\n${ok ? '🎉 链路验证通过' : '⚠️  有失败项'}\n`);
  process.exit(ok ? 0 : (code || 1));
}

function wavHeader(dataLen, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}

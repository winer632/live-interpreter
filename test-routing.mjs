/**
 * 端到端自测（需先启动服务：`npm run demo`）
 *
 * 用与浏览器完全相同的方式连上 /ws，检验归一化事件流：
 *   1. 每句的方向判定正确
 *   2. 原文/译文落在正确的语言栏
 *   3. 句子最终被标记为 final
 *   4. 译音有下发
 *
 *   node test-routing.mjs
 */

import { WebSocket } from 'ws';

const EXPECT = [
  { dir: 'zh2en', zh: '王先生您好，非常感谢您今天专程过来。', en: 'Hello, thank you very much for making the trip here today.' },
  { dir: 'en2zh', en: 'My pleasure. Could you walk me through the pricing model first?', zh: '很荣幸。能先给我讲一下你们的定价模式吗？' },
  { dir: 'zh2en', zh: '当然可以。我们按月订阅，基础版每个席位五十美元。', en: 'Of course. We charge a monthly subscription, fifty dollars per seat for the basic tier.' },
  { dir: 'en2zh', en: 'That sounds reasonable. What about enterprise deployment and data security?', zh: '听起来挺合理。那企业部署和数据安全方面呢？' },
  { dir: 'zh2en', zh: '数据全部私有化部署，这个 pipeline 的 latency 我们也做了优化。', en: 'All data is deployed on-premises, and we have also optimised the latency of this pipeline.' },
];

const lines = new Map();   // id → 最后一次收到的状态（与前端渲染逻辑一致）
let audioChunks = 0;
let audioBytes = 0;
let dirEvents = 0;
let ready = null;

const ws = new WebSocket('ws://localhost:5173/ws');

ws.on('error', (e) => {
  console.error('连接失败：', e.message, '\n请先运行 npm run demo');
  process.exit(1);
});

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  switch (m.t) {
    case 'ready':
      ready = m;
      console.log(`已连接 · 后端 ${m.backend} · 输入采样率 ${m.inputRate}Hz`);
      console.log('约 47 秒跑完 5 轮对话…\n');
      break;
    case 'dir':
      dirEvents += 1;
      break;
    case 'line':
      lines.set(m.id, m);
      break;
    case 'audio': {
      audioChunks += 1;
      audioBytes += Math.floor((m.pcm.length * 3) / 4);
      break;
    }
    case 'closed':
      finish();
      break;
    case 'error':
      console.error('❌ 服务端报错：', m.message);
      process.exit(1);
  }
});

let done = false;
function finish() {
  if (done) return;
  done = true;
  try { ws.close(); } catch {}

  const got = [...lines.values()].sort((a, b) => a.id - b.id);

  console.log('=========== 字幕结果 ===========\n');
  for (const l of got) {
    const zh = l.dir === 'en2zh' ? l.dst : l.src;
    const en = l.dir === 'en2zh' ? l.src : l.dst;
    console.log(`[${l.dir === 'zh2en' ? '中→英' : '英→中'}]${l.final ? '' : '  (未完结)'}`);
    console.log(`  中文  ${zh || '(空)'}`);
    console.log(`  英文  ${en || '(空)'}\n`);
  }

  console.log('=========== 校验 ===========\n');
  let pass = true;
  const check = (ok, label, extra = '') => {
    console.log(`${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
    if (!ok) pass = false;
  };

  check(Boolean(ready), '收到 ready 事件');
  check(got.length === EXPECT.length, `断句数量 = ${EXPECT.length}`, `实际 ${got.length}`);

  EXPECT.forEach((exp, i) => {
    const l = got[i];
    if (!l) { check(false, `第 ${i + 1} 句存在`); return; }
    const zh = l.dir === 'en2zh' ? l.dst : l.src;
    const en = l.dir === 'en2zh' ? l.src : l.dst;
    check(l.dir === exp.dir, `第 ${i + 1} 句方向 ${exp.dir}`, l.dir === exp.dir ? '' : `实际 ${l.dir}`);
    check(zh === exp.zh, `第 ${i + 1} 句中文栏`, zh === exp.zh ? '' : `\n     期望 ${exp.zh}\n     实际 ${zh}`);
    check(en === exp.en, `第 ${i + 1} 句英文栏`, en === exp.en ? '' : `\n     期望 ${exp.en}\n     实际 ${en}`);
    check(l.final === true, `第 ${i + 1} 句已归档 final`);
  });

  const seconds = (audioBytes / 2 / 24000).toFixed(1);
  check(audioChunks > 0, `收到译音 ${audioChunks} 包 / 约 ${seconds}s`);
  check(dirEvents >= EXPECT.length, `方向事件 ≥ ${EXPECT.length}`, `实际 ${dirEvents}`);

  console.log(`\n${pass ? '🎉 全部通过' : '⚠️  有失败项'}\n`);
  process.exit(pass ? 0 : 1);
}

setTimeout(finish, 70000);

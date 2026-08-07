/**
 * 中日双会话方向判定探针
 *
 * 同时开 zh→ja 和 ja→zh 两条会话，喂同一段音频，观察两边的原文转写。
 * 目的：找出能区分"说的是中文还是日语"的可靠信号。
 */
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import protobuf from 'protobufjs';
import { WebSocket } from 'ws';

const ROOT = '/Users/wangxinxin/Desktop/voice';
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const root = new protobuf.Root();
root.resolvePath = (_o, t) => path.resolve(ROOT, 'protos', t);
root.loadSync('products/understanding/ast/ast_service.proto', { keepCase: true });
const Req = root.lookupType('data.speech.ast.TranslateRequest');
const Res = root.lookupType('data.speech.ast.TranslateResponse');

const which = process.argv[2] || 'zh';
const CASES = {
  zh: { voice: 'Tingting', text: '你好，很高兴见到你。我们来谈谈合作的细节。' },
  ja: { voice: 'Kyoko', text: 'こんにちは、お会いできて嬉しいです。協力の詳細についてお話ししましょう。' },
};
const { voice, text } = CASES[which];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ja-'));
execFileSync('say', ['-v', voice, '-o', `${tmp}/a.aiff`, text]);
execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', `${tmp}/a.aiff`, `${tmp}/a.wav`]);
const b = fs.readFileSync(`${tmp}/a.wav`);
let off = 12, pcm;
while (off + 8 <= b.length) {
  const id = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4);
  if (id === 'data') { pcm = b.subarray(off + 8, off + 8 + sz); break; }
  off += 8 + sz + (sz % 2);
}

console.log(`喂入【${which === 'zh' ? '中文' : '日语'}】音频（${voice}）：${text}\n`);

const KANA = /[぀-ヿ]/;
const stats = {};

function open(src, dst) {
  const tag = `${src}→${dst}`;
  stats[tag] = { srcText: '', dstText: '', audioBytes: 0 };
  const sid = crypto.randomUUID();
  const ws = new WebSocket('wss://openspeech.bytedance.com/api/v4/ast/v2/translate', {
    headers: {
      'X-Api-Key': cfg.volcengine.apiKey,
      'X-Api-Resource-Id': cfg.volcengine.resourceId,
      'X-Api-Connect-Id': crypto.randomUUID(),
    },
  });
  ws.binaryType = 'nodebuffer';
  const send = (o) => ws.readyState === 1 && ws.send(Req.encode(Req.create(o)).finish());

  ws.on('open', () => send({
    request_meta: { SessionID: sid },
    event: 100,
    user: { uid: 'probe' },
    source_audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
    target_audio: { format: 'pcm', rate: 24000, bits: 16, channel: 1 },
    // 不传 speaker_id → 声音复刻模式，才允许非中英的目标语种
    request: { mode: 's2s', source_language: src, target_language: dst },
  }));

  ws.on('message', (d) => {
    const r = Res.decode(d);
    const s = stats[tag];
    if (r.event === 150) { s.ready = true; maybeStream(); }
    if (r.event === 652) s.srcText = r.text || '';
    if (r.event === 655) s.dstText += (r.text || '');
    if (r.event === 352) s.audioBytes += r.data?.length || 0;
    if (r.event === 153) s.failed = `status=${r.response_meta?.StatusCode} ${r.response_meta?.Message || ''}`;
  });
  ws.on('error', (e) => { stats[tag].failed = e.message; });
  return { ws, send, sid };
}

const A = open('zh', 'ja');
const B = open('ja', 'zh');

let streamed = false;
async function maybeStream() {
  if (streamed || !stats['zh→ja'].ready || !stats['ja→zh'].ready) return;
  streamed = true;
  const F = 2560;
  for (let o = 0; o < pcm.length; o += F) {
    const chunk = pcm.subarray(o, o + F);
    for (const [c, s] of [[A, 'zh→ja'], [B, 'ja→zh']]) {
      c.send({ request_meta: { SessionID: c.sid }, event: 200, source_audio: { binary_data: chunk } });
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  const sil = Buffer.alloc(F);
  for (let i = 0; i < 90; i++) {
    for (const c of [A, B]) c.send({ request_meta: { SessionID: c.sid }, event: 200, source_audio: { binary_data: sil } });
    await new Promise((r) => setTimeout(r, 80));
  }
  report();
}

function report() {
  console.log('=========== 两条会话的表现 ===========\n');
  for (const [tag, s] of Object.entries(stats)) {
    const kana = (s.srcText.match(new RegExp(KANA, 'g')) || []).length;
    console.log(`【${tag}】${s.failed ? `失败 ${s.failed}` : ''}`);
    console.log(`  原文(${s.srcText.length}字, 假名${kana}): ${s.srcText || '(空)'}`);
    console.log(`  译文(${s.dstText.length}字): ${s.dstText || '(空)'}`);
    console.log(`  译音: ${(s.audioBytes / 2 / 24000).toFixed(1)}s\n`);
  }
  process.exit(0);
}

setTimeout(report, 60000);

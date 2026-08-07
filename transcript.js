/**
 * 字幕归档
 *
 * 一天一个 JSONL 文件，同一天的多场会谈都追加进去，用 session 记录分隔。
 *
 * 选 JSONL 而不是数据库的理由：append-only 天生抗崩溃（进程被杀也不会损坏
 * 已写内容），能直接 grep，导出就是读文件。这个场景不需要跨会谈检索，
 * 上数据库是徒增复杂度。
 *
 * 只归档已经归档（final）的整句，不写增量。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, 'transcripts');

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
}

/** 本地日期，不用 UTC —— 归档是给人看的，跨零点按本地时间分文件才合直觉 */
export function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fileFor(date) {
  return path.join(DIR, `${date}.jsonl`);
}

export function listDates() {
  ensureDir();
  return fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace(/\.jsonl$/, ''))
    .sort()
    .reverse();
}

function append(record) {
  ensureDir();
  fs.appendFileSync(fileFor(today()), JSON.stringify(record) + '\n', { mode: 0o600 });
}

/** 一场会谈开始 */
export function writeSessionStart({ backend, pair }) {
  const id = `${Date.now().toString(36)}`;
  append({ t: 'session', id, at: new Date().toISOString(), backend, pair });
  return id;
}

/** 一整句归档 */
export function writeLine(sessionId, line) {
  if (!line.src?.trim() && !line.dst?.trim()) return;
  append({
    t: 'line',
    s: sessionId,
    at: new Date().toISOString(),
    dir: line.dir,
    src: line.src,
    dst: line.dst,
  });
}

function readRecords(date) {
  const file = fileFor(date);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** 页面刷新后用来恢复现场：取指定日期最近 limit 条字幕 */
export function readLines(date = today(), limit = 500) {
  const lines = readRecords(date).filter((r) => r.t === 'line');
  return lines.slice(-limit);
}

/** 导出成 Markdown，按会谈分段 */
export function exportMarkdown(date = today()) {
  const records = readRecords(date);
  if (!records.length) return `# 传译记录 ${date}\n\n（当天没有记录）\n`;

  const BACKEND = { volcengine: '火山 AST 2.0', openai: 'OpenAI gpt-realtime-translate', mock: '演示模式' };
  const PAIR = { zhen: '中 ⇄ English', zhja: '中 ⇄ 日本語', yuezh: '粤语 → 普通话' };
  const time = (iso) => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });

  const out = [`# 传译记录 ${date}`, ''];
  let count = 0;

  for (const r of records) {
    if (r.t === 'session') {
      out.push('', `## 会谈 ${time(r.at)}`, '',
        `> ${BACKEND[r.backend] || r.backend} · ${PAIR[r.pair] || r.pair}`, '');
      continue;
    }
    if (r.t !== 'line') continue;
    count += 1;
    // 原文用引用块、译文用正文，打印出来一眼能分清
    out.push(`**${time(r.at)}**　${r.src || ''}`);
    if (r.dst) out.push('', `> ${r.dst}`);
    out.push('');
  }

  out.splice(1, 0, '', `共 ${count} 句。`);
  return out.join('\n');
}

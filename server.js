/**
 * 实时同声传译 · 本地服务端
 *
 * 职责：
 *  1. 托管前端静态页面
 *  2. 保管各家 API Key（不下发到浏览器）
 *  3. 按所选后端建立上游翻译会话，把结果归一化成同一套事件发给前端
 *
 * 浏览器的 WebSocket API 无法自定义请求头，两家的鉴权都必须在服务端完成；
 * 方向路由和分句也放在这里，前端因此只负责渲染。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

import { OpenAIBackend, testOpenAI } from './backends/openai.js';
import { VolcengineBackend, testVolcengine } from './backends/volcengine.js';
import { MockBackend } from './backends/mock.js';
import * as transcript from './transcript.js';
import { PAIRS } from './backends/common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(__dirname, 'config.json');

const PORT = Number(process.env.PORT) || 5173;
const MOCK = process.env.MOCK === '1' || process.argv.includes('--mock');

const BACKENDS = ['volcengine', 'openai'];

// ---------------------------------------------------------------- 配置读写

function readConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  c.backend = BACKENDS.includes(c.backend) ? c.backend : 'volcengine';
  c.openai = c.openai || {};
  c.volcengine = c.volcengine || {};
  c.options = c.options || {};

  // 环境变量优先，方便临时覆盖
  if (process.env.OPENAI_API_KEY) c.openai.apiKey = process.env.OPENAI_API_KEY;
  if (process.env.VOLC_API_KEY) c.volcengine.apiKey = process.env.VOLC_API_KEY;
  if (process.env.VOLC_APP_KEY) c.volcengine.appKey = process.env.VOLC_APP_KEY;
  if (process.env.VOLC_ACCESS_KEY) c.volcengine.accessKey = process.env.VOLC_ACCESS_KEY;
  c.volcengine.resourceId = c.volcengine.resourceId || 'volc.service_type.10053';
  return c;
}

function writeConfig(mutate) {
  const c = readConfig();
  mutate(c);
  // 环境变量注入的值不落盘
  const out = JSON.parse(JSON.stringify(c));
  if (process.env.OPENAI_API_KEY) delete out.openai.apiKey;
  if (process.env.VOLC_API_KEY) delete out.volcengine.apiKey;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  return c;
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 12) return `${key.slice(0, 3)}****`;
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

// ---------------------------------------------------- 代理支持（国内网络常用）

async function buildAgent() {
  const proxyUrl =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy || '';
  if (!proxyUrl) return { agent: undefined, proxyUrl: '' };
  try {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    return { agent: new HttpsProxyAgent(proxyUrl), proxyUrl };
  } catch {
    console.warn('[warn] 检测到代理配置但 https-proxy-agent 不可用，将直连');
    return { agent: undefined, proxyUrl: '' };
  }
}

const agentPromise = buildAgent();

/**
 * 火山的 openspeech.bytedance.com 在国内直连即可，走代理反而更慢甚至不通；
 * OpenAI 则通常必须走代理。所以按后端区分。
 */
async function agentFor(backend) {
  if (backend === 'volcengine' && process.env.VOLC_USE_PROXY !== '1') return undefined;
  return (await agentPromise).agent;
}

// ------------------------------------------------------------ 静态文件服务

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// ------------------------------------------------------------------ 自检

async function runTest(provider) {
  const c = readConfig();
  const agent = await agentFor(provider);
  if (provider === 'openai') return testOpenAI(c.openai.apiKey, agent);
  if (provider === 'volcengine') return testVolcengine(c.volcengine, agent);
  return { ok: false, message: `未知后端 ${provider}` };
}

// ------------------------------------------------------------------ HTTP

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/api/status') {
    const c = readConfig();
    const { proxyUrl } = await agentPromise;
    sendJson(res, 200, {
      mock: MOCK,
      backend: MOCK ? 'mock' : c.backend,
      proxy: proxyUrl || null,
      options: c.options,
      providers: {
        openai: {
          hasKey: Boolean(c.openai.apiKey),
          keyPreview: maskKey(c.openai.apiKey),
          fromEnv: Boolean(process.env.OPENAI_API_KEY),
        },
        volcengine: {
          hasKey: Boolean(c.volcengine.apiKey || c.volcengine.appKey),
          keyPreview: maskKey(c.volcengine.apiKey || c.volcengine.appKey),
          fromEnv: Boolean(process.env.VOLC_API_KEY),
          resourceId: c.volcengine.resourceId,
        },
      },
    });
    return;
  }

  if (pathname === '/api/key' && req.method === 'POST') {
    try {
      const { provider, key, appKey, accessKey } = await readJsonBody(req);
      if (!BACKENDS.includes(provider)) {
        sendJson(res, 400, { ok: false, message: '未知后端' });
        return;
      }
      const trimmed = String(key || '').trim();
      if (provider === 'openai' && trimmed && !trimmed.startsWith('sk-')) {
        sendJson(res, 400, { ok: false, message: 'OpenAI API Key 应以 sk- 开头' });
        return;
      }
      writeConfig((c) => {
        if (trimmed) c[provider].apiKey = trimmed;
        if (provider === 'volcengine') {
          if (appKey !== undefined) c.volcengine.appKey = String(appKey || '').trim();
          if (accessKey !== undefined) c.volcengine.accessKey = String(accessKey || '').trim();
        }
      });
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { ok: false, message: String(e.message || e) });
    }
    return;
  }

  if (pathname === '/api/backend' && req.method === 'POST') {
    const { backend } = await readJsonBody(req).catch(() => ({}));
    if (!BACKENDS.includes(backend)) {
      sendJson(res, 400, { ok: false, message: '未知后端' });
      return;
    }
    writeConfig((c) => { c.backend = backend; });
    sendJson(res, 200, { ok: true, backend });
    return;
  }

  if (pathname === '/api/options' && req.method === 'POST') {
    const patch = await readJsonBody(req).catch(() => ({}));
    const c = writeConfig((cfg) => { cfg.options = { ...cfg.options, ...patch }; });
    sendJson(res, 200, { ok: true, options: c.options });
    return;
  }

  // 归档文件清单（文件管理用）
  if (pathname === '/api/transcripts') {
    sendJson(res, 200, { today: transcript.today(), files: transcript.listFiles() });
    return;
  }

  // 读取某天的字幕：刷新恢复现场、以及文件管理里的"查看"
  if (pathname === '/api/transcript' && req.method === 'GET') {
    const { searchParams } = new URL(req.url, 'http://localhost');
    const date = searchParams.get('date') || transcript.today();
    const limit = Math.min(5000, Number(searchParams.get('limit')) || 500);
    try {
      sendJson(res, 200, { date, dates: transcript.listDates(), lines: transcript.readLines(date, limit) });
    } catch (e) {
      sendJson(res, 400, { ok: false, message: String(e.message || e) });
    }
    return;
  }

  // 删除某天的归档 —— 不可撤销，所以只认 DELETE，避免被预取之类的误触发
  if (pathname === '/api/transcript' && req.method === 'DELETE') {
    const { searchParams } = new URL(req.url, 'http://localhost');
    try {
      const removed = transcript.removeFile(searchParams.get('date'));
      sendJson(res, 200, { ok: true, removed });
    } catch (e) {
      sendJson(res, 400, { ok: false, message: String(e.message || e) });
    }
    return;
  }

  // 导出：Markdown 或原始 JSONL
  if (pathname === '/api/export') {
    const { searchParams } = new URL(req.url, 'http://localhost');
    const date = searchParams.get('date') || transcript.today();
    const raw = searchParams.get('format') === 'jsonl';
    try {
      const body = raw ? transcript.readRaw(date) : transcript.exportMarkdown(date);
      res.writeHead(200, {
        'content-type': raw ? 'application/x-ndjson; charset=utf-8' : 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="transcript-${date}.${raw ? 'jsonl' : 'md'}"`,
      });
      res.end(body);
    } catch (e) {
      sendJson(res, 400, { ok: false, message: String(e.message || e) });
    }
    return;
  }

  if (pathname === '/api/test' && req.method === 'POST') {
    const { provider } = await readJsonBody(req).catch(() => ({}));
    const c = readConfig();
    sendJson(res, 200, await runTest(provider || c.backend));
    return;
  }

  serveStatic(req, res);
});

// -------------------------------------------------------- WebSocket 会话

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  if (pathname !== '/ws') { socket.destroy(); return; }
  // 语言对在建连时定死：中日要开两条上游会话，中英只开一条，切换必须重连
  const requested = searchParams.get('pair');
  const pair = PAIRS[requested] ? requested : 'zhen';
  // 不要译音时直接让上游走 s2t —— 实测 output_audio_tokens 约占总量六成，
  // 只在浏览器端静音等于白烧这笔钱
  const speak = searchParams.get('speak') !== '0';
  wss.handleUpgrade(req, socket, head, (client) => session(client, pair, speak));
});

async function session(client, pair = 'zhen', speak = true) {
  const cfg = readConfig();
  const backendName = MOCK ? 'mock' : cfg.backend;
  // 演示模式不脏化归档
  const archiveId = MOCK ? null : transcript.writeSessionStart({ backend: backendName, pair });

  const emit = (msg) => {
    // 只归档已经定稿的整句，增量不写
    if (archiveId && msg.t === 'line' && msg.final) {
      try { transcript.writeLine(archiveId, msg); } catch (e) { console.warn('[transcript] 写入失败', e.message); }
    }
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg));
  };

  let backend;
  try {
    if (MOCK) {
      backend = new MockBackend({ emit });
      backend.start();
    } else if (cfg.backend === 'volcengine') {
      if (!cfg.volcengine.apiKey && !cfg.volcengine.appKey) {
        emit({ t: 'error', message: '尚未配置火山 API Key', fatal: true });
        client.close();
        return;
      }
      backend = new VolcengineBackend({ ...cfg.volcengine, pair, speak, options: cfg.options, emit });
      backend.start(await agentFor('volcengine'));
    } else {
      if (!cfg.openai.apiKey) {
        emit({ t: 'error', message: '尚未配置 OpenAI API Key', fatal: true });
        client.close();
        return;
      }
      if (pair !== 'zhen') {
        emit({ t: 'error', message: 'OpenAI 后端只支持中英互译，中日 / 粤普请切换到火山后端', fatal: true });
        client.close();
        return;
      }
      // OpenAI 的端点没有纯文本模式，音频照样会生成、照样计费，
      // 这里只是不再往浏览器转发
      backend = new OpenAIBackend({ apiKey: cfg.openai.apiKey, speak, options: cfg.options, emit });
      backend.start(await agentFor('openai'));
    }
  } catch (err) {
    emit({ t: 'error', message: `后端启动失败：${err?.message || err}`, fatal: true });
    client.close();
    return;
  }

  console.log(`[ws] 会话开始 · 后端 ${MOCK ? 'mock' : cfg.backend} · 语言对 ${pair}`);

  client.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'audio' && msg.pcm) backend.sendAudio(msg.pcm);
    else if (msg.t === 'mode') backend.setMode(msg.mode);
  });

  const shutdown = () => {
    try { backend.close(); } catch {}
    console.log('[ws] 会话结束');
  };
  client.on('close', shutdown);
  client.on('error', shutdown);
}

// ------------------------------------------------------------------ 启动

if (process.argv.includes('--check')) {
  const c = readConfig();
  const which = process.argv.includes('--openai') ? 'openai'
    : process.argv.includes('--volcengine') ? 'volcengine'
    : c.backend;
  console.log(`检测后端：${which}`);
  const r = await runTest(which);
  console.log(r.ok ? `✅ ${r.message}` : `❌ [${r.stage}] ${r.message}`);
  if (r.detail) console.log(`   详情: ${r.detail}`);
  if (r.logId) console.log(`   logid: ${r.logId}`);
  const { proxyUrl } = await agentPromise;
  if (proxyUrl) console.log(`   代理: ${proxyUrl}${which === 'volcengine' && process.env.VOLC_USE_PROXY !== '1' ? '（火山默认直连，未使用）' : ''}`);
  process.exit(r.ok ? 0 : 1);
}

server.listen(PORT, '127.0.0.1', async () => {
  const c = readConfig();
  const { proxyUrl } = await agentPromise;
  const name = { volcengine: '火山 AST 2.0', openai: 'OpenAI gpt-realtime-translate', mock: '演示模式' };
  console.log('');
  console.log(`  🎙  实时同声传译已启动${MOCK ? '   【演示模式 · 不消耗额度】' : ''}`);
  console.log(`     打开浏览器访问  http://localhost:${PORT}`);
  if (MOCK) {
    console.log('     播放的是合成音：中→英 440Hz / 英→中 660Hz');
  } else {
    console.log(`     后端 ${name[c.backend]}`);
    const p = c.backend === 'openai' ? c.openai : c.volcengine;
    console.log(`     Key  ${p.apiKey || p.appKey ? maskKey(p.apiKey || p.appKey) : '未配置（可在网页里填写）'}`);
    if (proxyUrl) console.log(`     代理 ${proxyUrl}${c.backend === 'volcengine' ? '（火山直连，不走代理）' : ''}`);
  }
  console.log('');
});

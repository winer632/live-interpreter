/**
 * 中英双向实时同声传译 · 前端
 *
 * 前端是纯展示层。方向路由、分句、防回环闸门全在服务端，所以不管底层跑的是
 * 火山 AST 还是 OpenAI，这里收到的都是同一套事件：
 *
 *   { t:'ready', backend, inputRate }
 *   { t:'dir',   dir }                        方向变化
 *   { t:'line',  id, dir, src, dst, final }   一整句的最新全量状态
 *   { t:'audio', pcm }                        译音，base64 PCM16 24kHz
 *   { t:'usage' | 'error' | 'closed', ... }
 */

const OUTPUT_RATE = 24000;

/**
 * 语言对：a 在左栏、b 在右栏，方向标识形如 `${a}2${b}`。
 *
 * yuezh 是单向的 —— 实测火山 s2s 里粤语两个方向的模型都不存在，只有
 * s2t 的 yue-CN→zh 可用，所以只有字幕、没有译音。
 */
const PAIRS = {
  zhen: { a: 'zh', b: 'en', left: '中文', right: 'English', name: '中英' },
  zhja: { a: 'zh', b: 'ja', left: '中文', right: '日本語', name: '中日' },
  zhde: { a: 'zh', b: 'de', left: '中文', right: 'Deutsch', name: '中德' },
  zhfr: { a: 'zh', b: 'fr', left: '中文', right: 'Français', name: '中法' },
  // 韩泰不在火山 s2s 的 8 语种里，只能走 s2t，因此没有译音
  zhko: { a: 'zh', b: 'ko', left: '中文', right: '한국어', name: '中韩', noAudio: true },
  zhth: { a: 'zh', b: 'th', left: '中文', right: 'ไทย', name: '中泰', noAudio: true },
  yuezh: { a: 'yue', b: 'zh', left: '粤语', right: '普通话', name: '粤→普', oneWay: true, noAudio: true },
};
const dirLabel = (p, forward) =>
  forward ? `${p.left} → ${p.right}` : `${p.right} → ${p.left}`;

/** DOM 里最多保留的行数。每行约 5 个节点，2000 行浏览器毫无压力，
 *  约合 3 小时连续对话；再早的内容归档在服务端，点「导出」能拿到全部。 */
const MAX_ROWS = 2000;

const state = {
  running: false,
  pair: 'zhen',
  epoch: 0,          // 每次建连 +1；历史行用 'h'，避免与新会话的行号撞车
  stick: true,       // 是否贴在底部自动滚动
  trimmed: false,
  backend: null,
  inputRate: 24000,
  echoGuard: 'aec',      // aec | duck | mute
  volume: 0.9,
  micMuted: false,
  lines: new Map(),      // id → { data, node }
};

const $ = (s) => document.querySelector(s);
const el = {
  status: $('#status'),
  startBtn: $('#startBtn'),
  backendBadge: $('#backendBadge'),
  pairSelect: $('#pairSelect'),
  headLeft: $('#headLeft'),
  headRight: $('#headRight'),
  dirBadge: $('#dirBadge'),
  meterFill: $('#meterFill'),
  transcript: $('#transcript'),
  emptyHint: $('#emptyHint'),
  settingsBtn: $('#settingsBtn'),
  settings: $('#settings'),
  backendSelect: $('#backendSelect'),
  volcKey: $('#volcKey'),
  volcStatus: $('#volcStatus'),
  saveVolc: $('#saveVolc'),
  testVolc: $('#testVolc'),
  openaiKey: $('#openaiKey'),
  openaiStatus: $('#openaiStatus'),
  saveOpenai: $('#saveOpenai'),
  testOpenai: $('#testOpenai'),
  testResult: $('#testResult'),
  echoSelect: $('#echoSelect'),
  volumeInput: $('#volumeInput'),
  volumeLabel: $('#volumeLabel'),
  closeSettings: $('#closeSettings'),
  clearBtn: $('#clearBtn'),
  fullscreenBtn: $('#fullscreenBtn'),
  muteBtn: $('#muteBtn'),
  toast: $('#toast'),
  filesBtn: $('#filesBtn'),
  files: $('#files'),
  closeFiles: $('#closeFiles'),
  fileList: $('#fileList'),
  fileViewer: $('#fileViewer'),
  viewerTitle: $('#viewerTitle'),
  viewerMeta: $('#viewerMeta'),
  viewerBody: $('#viewerBody'),
  backToList: $('#backToList'),
  usageBadge: $('#usageBadge'),
  lagBadge: $('#lagBadge'),
  termList: $('#termList'),
  termCount: $('#termCount'),
  termStatus: $('#termStatus'),
  addTerm: $('#addTerm'),
  saveTerms: $('#saveTerms'),
};

// ------------------------------------------------------------ 术语库

const MAX_TERMS = 10;

function termRow(term = { text: '', wrong: [] }) {
  const row = document.createElement('div');
  row.className = 'term-row';
  row.innerHTML = `
    <input class="term-text" placeholder="正确写法，如 SensePedia" spellcheck="false" autocomplete="off">
    <input class="term-wrong" placeholder="常见误识，逗号分隔（可留空）" spellcheck="false" autocomplete="off">
    <button type="button" class="ghost small term-del" title="删除">✕</button>`;
  row.querySelector('.term-text').value = term.text || '';
  row.querySelector('.term-wrong').value = (term.wrong || []).join('、');
  row.querySelector('.term-del').onclick = () => { row.remove(); updateTermCount(); };
  return row;
}

function updateTermCount() {
  const n = el.termList.querySelectorAll('.term-row').length;
  el.termCount.textContent = `${n}/${MAX_TERMS}`;
  el.addTerm.disabled = n >= MAX_TERMS;
}

function renderTerms(terms = []) {
  el.termList.innerHTML = '';
  const list = terms.length ? terms.slice(0, MAX_TERMS) : [{ text: '', wrong: [] }];
  for (const t of list) el.termList.appendChild(termRow(t));
  updateTermCount();
}

function collectTerms() {
  return [...el.termList.querySelectorAll('.term-row')]
    .map((row) => ({
      text: row.querySelector('.term-text').value.trim(),
      // 中英文逗号、顿号都能当分隔符
      wrong: row.querySelector('.term-wrong').value
        .split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
    }))
    .filter((t) => t.text)
    .slice(0, MAX_TERMS);
}

/**
 * 用量统计。
 *
 * 注意：火山的同传 WebSocket 只回**本次消耗**（UsageResponse 事件），
 * 账户剩余额度需要走另一套需 AK/SK 签名的 OpenAPI，这里拿不到。
 * 所以显示的是"已用"而不是"剩余"。
 */
const usage = { ms: 0, tokens: {} };

function renderUsage() {
  if (!usage.ms && !Object.keys(usage.tokens).length) return;
  const min = usage.ms / 60000;
  const total = Object.values(usage.tokens).reduce((a, b) => a + b, 0);
  const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

  el.usageBadge.textContent = `已用 ${min < 1 ? `${(usage.ms / 1000).toFixed(0)}s` : `${min.toFixed(1)}min`}`
    + (total ? ` · ${fmt(total)} token` : '');
  el.usageBadge.title =
    `本次会话累计消耗（火山接口不提供账户剩余额度）\n`
    + `音频时长 ${(usage.ms / 1000).toFixed(1)}s\n`
    + Object.entries(usage.tokens).map(([k, v]) => `${k} ${Math.round(v)}`).join('\n');
  el.usageBadge.hidden = false;
}

// ------------------------------------------------------------ 工具

function pcm16ToFloat32(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  return f32;
}

function float32ToPCM16Base64(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(i16.buffer);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function toast(msg, kind = 'info') {
  el.toast.textContent = msg;
  el.toast.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.className = 'toast'; }, 5000);
}

function setStatus(text, kind) {
  el.status.textContent = text;
  el.status.className = `status ${kind || ''}`;
}

// ------------------------------------------------------------ 译音播放

/**
 * 把陆续到达的译音片段无缝排队播放。
 *
 * 同传里最容易毁掉整场会谈的问题是**译音累积延迟**：合成语音的时长普遍比源语音
 * 长（实测火山约 1.5–2.3 倍，含句间静音），如果只是老老实实排队，积压会随会谈
 * 时长单调增长，说了半小时可能落后十几分钟。
 *
 * 这里用两级补偿：
 *   · 积压 > 1.5s 起逐级加快播放速度（最高 1.35 倍，听感上还算自然）
 *   · 积压 > 8s 说明已经追不回来，直接跳过队列从当前时刻重排，宁可丢一点也不能拖
 */
const BACKLOG_SOFT = 1.5;
const BACKLOG_HARD = 8;

class Player {
  constructor() {
    this.ctx = new AudioContext({ sampleRate: OUTPUT_RATE, latencyHint: 'interactive' });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = state.volume;
    this.gain.connect(this.ctx.destination);
    this.next = 0;
    this.sources = new Set();
    this.dropped = 0;
  }

  /** 队列里还没播完的秒数 */
  get backlog() { return Math.max(0, this.next - this.ctx.currentTime); }

  push(f32) {
    let backlog = this.backlog;

    if (backlog > BACKLOG_HARD) {
      // 追不上了，砍掉积压重新对齐
      for (const s of this.sources) { try { s.stop(); } catch {} }
      this.sources.clear();
      this.next = 0;
      this.dropped += 1;
      backlog = 0;
    }

    const rate = backlog > 4 ? 1.35
      : backlog > 3 ? 1.25
      : backlog > BACKLOG_SOFT ? 1.12
      : 1;

    const buf = this.ctx.createBuffer(1, f32.length, OUTPUT_RATE);
    buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(this.gain);
    // 留 60ms 抖动余量，避免网络波动造成爆音
    const at = Math.max(this.ctx.currentTime + 0.06, this.next);
    src.start(at);
    this.next = at + buf.duration / rate;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  get playing() { return this.ctx.currentTime < this.next - 0.02; }

  setVolume(v) { this.gain.gain.value = v; }

  async close() {
    for (const s of this.sources) { try { s.stop(); } catch {} }
    this.sources.clear();
    this.next = 0;
    try { await this.ctx.close(); } catch {}
  }
}

// ------------------------------------------------------------ 音频采集

const audio = { ctx: null, stream: null, worklet: null, player: null, guardTimer: null };

async function startCapture(inputRate) {
  audio.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,   // 主力防回环
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  audio.ctx = new AudioContext({ sampleRate: inputRate, latencyHint: 'interactive' });
  await audio.ctx.resume();
  await audio.ctx.audioWorklet.addModule('pcm-worklet.js');

  const src = audio.ctx.createMediaStreamSource(audio.stream);
  // 火山建议 80ms 一包，OpenAI 用 40ms
  const frameSize = Math.round(inputRate * (inputRate === 16000 ? 0.08 : 0.04));
  audio.worklet = new AudioWorkletNode(audio.ctx, 'pcm-capture', { processorOptions: { frameSize } });
  src.connect(audio.worklet);

  // Worklet 必须接到 destination 才会被驱动；用 0 增益避免麦克风直接外放
  const sink = audio.ctx.createGain();
  sink.gain.value = 0;
  audio.worklet.connect(sink).connect(audio.ctx.destination);

  audio.worklet.port.onmessage = (e) => {
    const { pcm, peak } = e.data;
    drawMeter(peak);
    send({ t: 'audio', pcm: float32ToPCM16Base64(pcm) });
  };

  startEchoGuard();
}

async function stopCapture() {
  clearInterval(audio.guardTimer);
  if (audio.worklet) audio.worklet.port.onmessage = null;
  try { audio.worklet?.disconnect(); } catch {}
  audio.stream?.getTracks().forEach((t) => t.stop());
  try { await audio.ctx?.close(); } catch {}
  await audio.player?.close();
  audio.ctx = audio.stream = audio.worklet = audio.player = null;
  drawMeter(0);
}

/** 按设置在播放译音时调整麦克风增益 */
function startEchoGuard() {
  clearInterval(audio.guardTimer);
  let last = null;
  let tick = 0;
  audio.guardTimer = setInterval(() => {
    if (!audio.worklet) return;
    let g = state.micMuted ? 0 : 1;
    if (!state.micMuted && audio.player?.playing) {
      if (state.echoGuard === 'duck') g = 0.25;
      else if (state.echoGuard === 'mute') g = 0;
    }
    if (last !== g) {
      last = g;
      audio.worklet.port.postMessage({ gain: g });
    }

    // 每 500ms 刷新一次译音积压，落后太多时给出可见提示
    if (++tick % 10 === 0 && audio.player) {
      const lag = audio.player.backlog;
      if (lag > 1) {
        el.lagBadge.textContent = `译音滞后 ${lag.toFixed(1)}s`;
        el.lagBadge.className = `pill ${lag > 4 ? 'warn' : ''}`;
        el.lagBadge.hidden = false;
      } else {
        el.lagBadge.hidden = true;
      }
    }
  }, 50);
}

function drawMeter(peak) {
  const pct = Math.min(100, Math.round(Math.sqrt(peak) * 140));
  el.meterFill.style.width = `${pct}%`;
  el.meterFill.classList.toggle('hot', pct > 88);
}

// ------------------------------------------------------------ 字幕渲染

function renderLine(data, epoch = state.epoch) {
  el.emptyHint.hidden = true;
  const key = `${epoch}:${data.id}`;
  let entry = state.lines.get(key);

  if (!entry) {
    const row = document.createElement('div');
    row.className = `turn ${data.dir || ''}`;
    row.innerHTML = `
      <div class="cell zh"><span class="text"></span></div>
      <div class="arrow" aria-hidden="true"></div>
      <div class="cell en"><span class="text"></span></div>`;
    el.transcript.appendChild(row);
    entry = { node: row };
    state.lines.set(key, entry);
    // Map 保序，超出上限就从最老的开始摘。内容已归档在服务端，不会真丢
    if (state.lines.size > MAX_ROWS) {
      const oldestKey = state.lines.keys().next().value;
      state.lines.get(oldestKey)?.node.remove();
      state.lines.delete(oldestKey);
      if (!state.trimmed) {
        state.trimmed = true;
        toast('屏幕上只保留最近 2000 句，更早的内容已归档，点「导出」可取回全部');
      }
    }
  }

  const { node } = entry;
  const p = PAIRS[state.pair];
  const forward = data.dir === `${p.a}2${p.b}`;   // 左栏语言 → 右栏语言
  node.className = `turn ${forward ? 'zh2en' : 'en2zh'}${data.final ? '' : ' live'}`;
  node.querySelector('.arrow').textContent = forward ? '→' : '←';

  // src 是源语言、dst 是目标语言，按方向落到左右两栏
  const zh = forward ? data.src : data.dst;
  const en = forward ? data.dst : data.src;
  node.querySelector('.cell.zh .text').textContent = zh || '';
  node.querySelector('.cell.en .text').textContent = en || '';

  // 贴底状态由 scroll 事件维护。原先每次增量更新都读 scrollHeight，
  // 那是一次强制同步布局，行数一多就是每秒好几次 reflow
  if (state.stick) el.transcript.scrollTop = Number.MAX_SAFE_INTEGER;
}

el.transcript.addEventListener('scroll', () => {
  const { scrollHeight, scrollTop, clientHeight } = el.transcript;
  state.stick = scrollHeight - scrollTop - clientHeight < 200;
}, { passive: true });

function setDirection(dir) {
  if (!dir) {
    el.dirBadge.textContent = '等待发言…';
    el.dirBadge.className = 'dir-badge';
    return;
  }
  const p = PAIRS[state.pair];
  const forward = dir === `${p.a}2${p.b}`;
  el.dirBadge.textContent = dirLabel(p, forward);
  // 样式沿用中英那套：正向用 zh2en 的配色，反向用 en2zh
  el.dirBadge.className = `dir-badge ${forward ? 'zh2en' : 'en2zh'}`;
}

// ------------------------------------------------------------ 连接

let ws = null;

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?pair=${state.pair}`);

  ws.onmessage = async (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }

    switch (m.t) {
      case 'ready': {
        state.epoch += 1;
        state.backend = m.backend;
        state.inputRate = m.inputRate;
        el.backendBadge.textContent = { volcengine: '火山 AST', openai: 'OpenAI', mock: '演示' }[m.backend] || m.backend;
        el.backendBadge.hidden = false;

        // 火山是单会话中英互译，没有"方向冻结"那层保护，默认把闸门开到压低档
        if (state.echoGuard === 'aec' && m.backend === 'volcengine') {
          state.echoGuard = 'duck';
          el.echoSelect.value = 'duck';
        }

        if (!audio.ctx) {
          try {
            audio.player = new Player();
            await startCapture(m.inputRate);
            setStatus(m.backend === 'mock' ? '演示模式运行中' : '已就绪 · 请开始说话', 'ok');
          } catch (err) {
            const msg = err?.name === 'NotAllowedError'
              ? '麦克风权限被拒绝。请在「系统设置 → 隐私与安全性 → 麦克风」中允许浏览器访问。'
              : `启动失败：${err?.message || err}`;
            toast(msg, 'err');
            stop();
          }
        }
        break;
      }

      case 'dir':
        setDirection(m.dir);
        break;

      case 'line':
        renderLine(m);
        break;

      case 'audio':
        audio.player?.push(pcm16ToFloat32(m.pcm));
        break;

      case 'usage':
        usage.ms += m.durationMs || 0;
        for (const it of m.items || []) {
          if (!it.unit) continue;
          usage.tokens[it.unit] = (usage.tokens[it.unit] || 0) + Number(it.quantity || 0);
        }
        renderUsage();
        break;

      case 'error':
        setStatus('出错', 'err');
        toast(m.message, 'err');
        if (m.detail) console.error('[interpreter]', m.message, m.detail);
        if (m.fatal) { stop(); openSettings(); }
        break;

      case 'closed':
        toast(m.reason || '会话已结束');
        stop();
        break;
    }
  };

  ws.onclose = () => {
    if (state.running) {
      setStatus('连接中断', 'err');
      stop();
    }
  };
}

// ------------------------------------------------------------ 启停

async function start() {
  if (state.running) return;
  el.startBtn.disabled = true;
  setStatus('正在连接…', 'warn');
  try {
    state.running = true;
    connect();
    el.startBtn.textContent = '停止';
    el.startBtn.classList.add('stop');
  } finally {
    el.startBtn.disabled = false;
  }
}

function stop() {
  state.running = false;
  try { ws?.close(); } catch {}
  ws = null;
  stopCapture();
  setDirection(null);
  el.lagBadge.hidden = true;
  el.startBtn.textContent = '开始传译';
  el.startBtn.classList.remove('stop');
  setStatus('未连接', '');
}

// ------------------------------------------------------------ 设置面板

async function refreshStatus() {
  const st = await fetch('/api/status').then((r) => r.json()).catch(() => null);
  if (!st) return null;

  el.backendSelect.value = st.backend === 'mock' ? 'volcengine' : st.backend;
  el.backendSelect.disabled = st.mock;

  const fill = (node, p, name, hint) => {
    if (p.hasKey) {
      node.textContent = `${p.fromEnv ? '已从环境变量读取' : '已保存'}：${p.keyPreview}`;
      node.className = 'hint ok';
    } else {
      node.textContent = hint;
      node.className = 'hint warn';
    }
  };
  fill(el.volcStatus, st.providers.volcengine, '火山', '尚未配置。控制台 → 服务中心 → 开通同声传译后获取 API Key。');
  fill(el.openaiStatus, st.providers.openai, 'OpenAI', '尚未配置。platform.openai.com → API keys 创建。');

  renderTerms(st.options?.terms || []);

  if (st.mock) {
    document.querySelector('.brand .sub').textContent = '演示模式 · 不消耗额度';
    document.querySelector('.brand .sub').style.color = 'var(--warn)';
  }
  return st;
}

function openSettings() {
  el.settings.showModal();
  refreshStatus();
}

el.settingsBtn.onclick = openSettings;
el.closeSettings.onclick = () => el.settings.close();

async function saveKey(provider, input) {
  const key = input.value.trim();
  if (!key) return;
  const r = await fetch('/api/key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, key }),
  }).then((x) => x.json());
  if (r.ok) {
    input.value = '';
    toast('已保存到本地 config.json', 'ok');
    refreshStatus();
  } else {
    toast(r.message || '保存失败', 'err');
  }
}

el.saveVolc.onclick = () => saveKey('volcengine', el.volcKey);
el.saveOpenai.onclick = () => saveKey('openai', el.openaiKey);

async function runTest(provider, btn) {
  el.testResult.textContent = `正在测试 ${provider === 'volcengine' ? '火山' : 'OpenAI'} 连接…`;
  el.testResult.className = 'hint';
  btn.disabled = true;
  try {
    const r = await fetch('/api/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider }),
    }).then((x) => x.json());
    el.testResult.textContent = (r.ok ? '✅ ' : '❌ ') + r.message
      + (r.detail ? `\n${r.detail}` : '')
      + (r.logId ? `\nlogid: ${r.logId}` : '');
    el.testResult.className = `hint ${r.ok ? 'ok' : 'warn'}`;
  } catch (e) {
    el.testResult.textContent = `❌ ${e.message || e}`;
    el.testResult.className = 'hint warn';
  } finally {
    btn.disabled = false;
  }
}

el.testVolc.onclick = () => runTest('volcengine', el.testVolc);
el.testOpenai.onclick = () => runTest('openai', el.testOpenai);

el.backendSelect.onchange = async () => {
  await fetch('/api/backend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backend: el.backendSelect.value }),
  });
  toast(`已切换到 ${el.backendSelect.value === 'volcengine' ? '火山 AST' : 'OpenAI'}，下次开始传译时生效`, 'ok');
};

el.addTerm.onclick = () => {
  if (el.termList.querySelectorAll('.term-row').length >= MAX_TERMS) return;
  el.termList.appendChild(termRow());
  updateTermCount();
  el.termList.lastElementChild.querySelector('.term-text').focus();
};

el.saveTerms.onclick = async () => {
  const terms = collectTerms();
  const r = await fetch('/api/options', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ terms }),
  }).then((x) => x.json()).catch(() => null);

  if (r?.ok) {
    el.termStatus.textContent = `已保存 ${terms.length} 条`;
    el.termStatus.className = 'hint ok';
    toast(state.running ? '术语库已保存，重新点「开始传译」后生效' : '术语库已保存', 'ok');
  } else {
    el.termStatus.textContent = '保存失败';
    el.termStatus.className = 'hint warn';
  }
};

el.echoSelect.onchange = () => { state.echoGuard = el.echoSelect.value; };

el.volumeInput.oninput = () => {
  state.volume = Number(el.volumeInput.value) / 100;
  el.volumeLabel.textContent = `${el.volumeInput.value}%`;
  audio.player?.setVolume(state.volume);
};

// ------------------------------------------------------------ 顶栏交互

el.startBtn.onclick = () => (state.running ? stop() : start());

el.pairSelect.onchange = () => {
  const next = el.pairSelect.value;
  if (next === state.pair) return;
  state.pair = next;
  el.headLeft.textContent = PAIRS[next].left;
  el.headRight.textContent = PAIRS[next].right;
  setDirection(null);

  const note = PAIRS[next].noAudio ? '（仅字幕，无译音）' : '';
  // 不同语言对的上游会话数和模式（s2s / s2t）都不一样，语言对是建连参数，必须重连
  if (state.running) {
    stop();
    setTimeout(start, 200);
    toast(`已切换到${PAIRS[next].name}${note}，正在重连…`);
  } else {
    toast(`已切换到${PAIRS[next].name}${note}`);
  }
};

el.clearBtn.onclick = () => {
  // 只清屏，归档在服务端不受影响
  state.lines.clear();
  state.trimmed = false;
  el.transcript.innerHTML = '';
  el.transcript.appendChild(el.emptyHint);
  el.emptyHint.hidden = false;
};

el.fullscreenBtn.onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
};

el.muteBtn.onclick = () => setMicMuted(!state.micMuted);

function setMicMuted(muted) {
  state.micMuted = muted;
  el.muteBtn.classList.toggle('active', muted);
  el.muteBtn.textContent = muted ? '🔇 已静音' : '🎤 麦克风';
}

// 空格键按住临时静音麦克风（应急打断用）
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && e.target === document.body) {
    e.preventDefault();
    setMicMuted(true);
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    setMicMuted(false);
  }
});

window.addEventListener('beforeunload', () => { if (state.running) stop(); });

// ------------------------------------------------------------ 历史与导出

/** 页面刷新后把当天已归档的字幕铺回来，接着往下记 */
async function restoreHistory() {
  const r = await fetch('/api/transcript?limit=500').then((x) => x.json()).catch(() => null);
  if (!r?.lines?.length) return;

  const stick = state.stick;
  state.stick = true;
  r.lines.forEach((l, i) => renderLine({ id: i, dir: l.dir, src: l.src, dst: l.dst, final: true }, 'h'));

  const sep = document.createElement('div');
  sep.className = 'history-sep';
  sep.textContent = `以上为 ${r.date} 已归档的 ${r.lines.length} 句`;
  el.transcript.appendChild(sep);

  state.stick = stick;
  el.transcript.scrollTop = Number.MAX_SAFE_INTEGER;
}

/** 走 <a download> 而不是 fetch，让浏览器直接接管下载 */
function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.click();
}

const fmtBytes = (n) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024 ? `${(n / 1024).toFixed(1)} KB`
    : `${n} B`;

const fmtTime = (iso) => {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
};

async function renderFileList() {
  el.fileViewer.hidden = true;
  el.fileList.hidden = false;

  const r = await fetch('/api/transcripts').then((x) => x.json()).catch(() => null);
  if (!r) { el.fileList.innerHTML = '<div class="file-empty">读取失败</div>'; return; }

  if (!r.files.length) {
    el.fileList.innerHTML = '<div class="file-empty">还没有任何归档。开始传译后会自动生成。</div>';
    return;
  }

  el.fileList.innerHTML = '';
  for (const f of r.files) {
    const isToday = f.date === r.today;
    const row = document.createElement('div');
    row.className = `file-row${isToday ? ' today' : ''}`;

    const span = f.firstAt && f.lastAt && f.firstAt !== f.lastAt
      ? `${fmtTime(f.firstAt)}–${fmtTime(f.lastAt)}` : fmtTime(f.firstAt);

    row.innerHTML = `
      <div class="meta">
        <div class="date">${f.date}${isToday ? '<span class="tag">今天</span>' : ''}</div>
        <div class="sub">${f.lines} 句 · ${f.sessions} 场会谈 · ${fmtBytes(f.bytes)}${span ? ` · ${span}` : ''}</div>
      </div>
      <div class="acts">
        <button type="button" class="ghost small act-view">查看</button>
        <button type="button" class="ghost small act-md">Markdown</button>
        <button type="button" class="ghost small act-raw">JSONL</button>
        <button type="button" class="ghost small danger act-del">删除</button>
      </div>`;

    row.querySelector('.act-view').onclick = () => viewFile(f);
    row.querySelector('.act-md').onclick = () => download(`/api/export?date=${f.date}`);
    row.querySelector('.act-raw').onclick = () => download(`/api/export?date=${f.date}&format=jsonl`);
    row.querySelector('.act-del').onclick = () => deleteFile(f, isToday);
    el.fileList.appendChild(row);
  }
}

async function viewFile(f) {
  const r = await fetch(`/api/transcript?date=${f.date}&limit=5000`).then((x) => x.json()).catch(() => null);
  if (!r?.lines) { toast('读取失败', 'err'); return; }

  el.fileList.hidden = true;
  el.fileViewer.hidden = false;
  el.viewerTitle.textContent = f.date;
  el.viewerMeta.textContent = `${r.lines.length} 句`;

  el.viewerBody.innerHTML = '';
  for (const l of r.lines) {
    const div = document.createElement('div');
    div.className = `viewer-line ${l.dir || ''}`;
    // 用 textContent 逐段写入，字幕内容不可信任，绝不拼进 innerHTML
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = fmtTime(l.at);
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = l.src || '';
    const d = document.createElement('span');
    d.className = 'd';
    d.textContent = l.dst || '';
    div.append(t, s, d);
    el.viewerBody.appendChild(div);
  }
}

async function deleteFile(f, isToday) {
  const warn = isToday
    ? `\n\n注意：这是今天的记录，正在进行的会谈仍会继续往里写。`
    : '';
  if (!confirm(`确定删除 ${f.date} 的归档吗？\n\n${f.lines} 句 · ${f.sessions} 场会谈\n此操作不可撤销。${warn}`)) return;

  const r = await fetch(`/api/transcript?date=${f.date}`, { method: 'DELETE' })
    .then((x) => x.json()).catch(() => null);
  if (r?.ok) {
    toast(`已删除 ${f.date}`, 'ok');
    renderFileList();
  } else {
    toast(r?.message || '删除失败', 'err');
  }
}

el.filesBtn.onclick = () => { el.files.showModal(); renderFileList(); };
el.closeFiles.onclick = () => el.files.close();
el.backToList.onclick = () => renderFileList();

// ------------------------------------------------------------ 初始化

(async function init() {
  setStatus('未连接', '');
  el.volumeLabel.textContent = `${el.volumeInput.value}%`;
  state.volume = Number(el.volumeInput.value) / 100;

  const st = await refreshStatus();
  if (!st) return;
  if (!st.mock) await restoreHistory();
  if (!st.mock && !st.providers[st.backend]?.hasKey) openSettings();
})();

/**
 * 后端公共层：语种检测 · 方向路由 · 分句成行
 *
 * OpenAI 与火山两个后端向浏览器发送的是同一套归一化事件，前端因此完全不需要
 * 知道底层用的是谁：
 *
 *   { t: 'ready',  backend, inputRate }
 *   { t: 'dir',    dir }                      当前翻译方向变化
 *   { t: 'line',   id, dir, src, dst, final } 一整句的最新状态（全量，前端直接覆盖）
 *   { t: 'audio',  pcm }                      译音，base64 PCM16 24kHz
 *   { t: 'usage',  ... }                      计费信息（火山）
 *   { t: 'error',  message, fatal }
 *   { t: 'closed', reason }
 */

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/;
const LATIN = /[A-Za-z]/;

/**
 * 中日文字 → zh；拉丁字母 → en；纯标点数字 → null（信息不足，不改方向）
 *
 * 只要出现汉字就判中文，不看比例：英文母语者的转写结果里不会冒出汉字，
 * 而中文里夹英文术语（"这是我们 SensePedia 的产品经理"）是常态。
 * 反过来按比例算的话，这种句子很容易被判成英文。
 */
export function detectLang(text) {
  if (CJK.test(text)) return 'zh';
  if (LATIN.test(text)) return 'en';
  return null;
}

/** 译音播完之后继续冻结方向的时间，用来吃掉扬声器的尾音 */
export const FREEZE_TAIL_MS = 350;

/**
 * 方向路由器。
 *
 * OpenAI 后端靠它决定放行哪条会话；火山 zhen 单会话模式只用它来决定字幕排版。
 *
 * frozen() 是防回环的关键：译音正在播放时不允许翻转方向，于是"扬声器→麦克风→
 * 反向翻译→扬声器"这个循环无法启动。
 */
export class DirectionRouter {
  constructor() {
    this.dir = null;        // zh2en | en2zh
    this.mode = 'auto';     // auto | zh2en | en2zh
    this.playUntil = 0;
    this.lastPlaying = 0;
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'auto') this.dir = mode;
  }

  /** 每发出一段译音就登记它的时长，用于估算播放何时结束 */
  notePlayback(ms) {
    this.playUntil = Math.max(this.playUntil, Date.now()) + ms;
  }

  get playing() {
    return Date.now() < this.playUntil;
  }

  frozen() {
    if (this.playing) {
      this.lastPlaying = Date.now();
      return true;
    }
    return Date.now() - this.lastPlaying < FREEZE_TAIL_MS;
  }

  /**
   * 依据源语言文本更新方向；返回方向是否真的变了。
   *
   * 传进来的必须是**整句累计文本**，不能是单个增量片段。中文句子里嵌英文术语时
   * （"这是我们 SensePedia 的产品经理"），单看 "SensePedia" 那个片段会判成英文，
   * 把整句的方向带翻——这是实测中真实踩到的坑。
   */
  observe(text) {
    if (this.mode !== 'auto') return false;
    const lang = detectLang(text);
    if (!lang) return false;
    const want = lang === 'zh' ? 'zh2en' : 'en2zh';
    if (want === this.dir) return false;
    if (this.frozen()) return false;
    this.dir = want;
    return true;
  }

  active(dir) {
    return this.mode === 'auto' ? dir === this.dir : dir === this.mode;
  }
}

/**
 * 字幕文本合并。
 *
 * 上游到底是发增量还是发全量，两家不一样，文档也没写死。这里两种都兼容：
 * 新文本以旧文本开头就当全量覆盖，否则按重叠长度接上去。
 */
export function mergeText(prev, next) {
  if (!prev) return next || '';
  if (!next) return prev;
  if (next.startsWith(prev)) return next;   // 全量刷新
  if (prev.endsWith(next)) return prev;     // 重复包
  const max = Math.min(prev.length, next.length);
  for (let k = max; k > 0; k--) {
    if (prev.endsWith(next.slice(0, k))) return prev + next.slice(k);
  }
  return prev + next;
}

/**
 * 把零散的字幕片段攒成一行行"原文 + 译文"。
 *
 * 火山有明确的句首/句尾事件（650/652 原文，653/655 译文），原文和译文各自计数，
 * 第 N 句原文自然对上第 N 句译文 —— 即使译文比原文慢半拍也不会串行。
 *
 * OpenAI 没有句子边界，退化成"方向变化或静默超时即断句"。
 */
export class LineBuilder {
  /**
   * @param {object} [o]
   * @param {Function} [o.transform] 发给前端之前对整句文本做的加工（术语纠正）。
   *   必须在这一层做而不是在增量片段上做：术语可能被切在两个片段之间，
   *   逐片段替换会漏掉。
   */
  constructor(emit, { idleMs = 1800, transform = null } = {}) {
    this.emit = emit;
    this.idleMs = idleMs;
    this.transform = transform;
    this.lines = new Map();
    this.finished = new Set();
    this.seq = { src: 0, dst: 0 };
    this.timer = null;
  }

  _line(which, dir) {
    const id = this.seq[which];
    // 这一句已经归档了，迟到的增量包直接丢弃，否则会把成品行冲成空行
    if (this.finished.has(id)) return null;
    let line = this.lines.get(id);
    if (!line) {
      line = { id, dir, src: '', dst: '', srcDone: false, dstDone: false };
      this.lines.set(id, line);
    }
    if (dir) line.dir = dir;
    return line;
  }

  _flush(line) {
    const final = line.srcDone && line.dstDone;
    const fix = this.transform;
    this.emit({
      t: 'line',
      id: line.id,
      dir: line.dir,
      src: fix ? fix(line.src) : line.src,
      dst: fix ? fix(line.dst) : line.dst,
      final,
    });
    if (final) {
      this.lines.delete(line.id);
      this.finished.add(line.id);
      // 只需记住最近若干句，避免无限增长
      if (this.finished.size > 200) {
        const oldest = Math.min(...this.finished);
        this.finished.delete(oldest);
      }
    }
  }

  _touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finalizeAll(), this.idleMs);
  }

  /** 显式句首（火山 650 / 653） */
  begin(which, dir) {
    this.seq[which] += 1;
    this._line(which, dir);
  }

  /** 显式句尾（火山 652 / 655） */
  end(which, dir) {
    const line = this._line(which, dir);
    if (!line) return;
    line[which === 'src' ? 'srcDone' : 'dstDone'] = true;
    this._flush(line);
  }

  /**
   * @param {boolean} replace true 表示 text 是整句全量（火山 652/655），
   *                          false 表示增量片段（火山 651/654、OpenAI 的 delta）
   */
  update(which, dir, text, replace = false) {
    const line = this._line(which, dir);
    if (!line) return;
    line[which] = replace ? text : mergeText(line[which], text);
    this._touch();
    this._flush(line);
  }

  /** 无显式边界时（OpenAI）：方向一变就换行 */
  advanceOnDirectionChange() {
    this.finalizeAll();
    this.seq.src += 1;
    this.seq.dst = this.seq.src;
  }

  finalizeAll() {
    clearTimeout(this.timer);
    for (const line of this.lines.values()) {
      if (line.src || line.dst) {
        line.srcDone = line.dstDone = true;
        this._flush(line);
      }
    }
    this.lines.clear();
    const n = Math.max(this.seq.src, this.seq.dst) + 1;
    this.seq.src = this.seq.dst = n;
  }

  dispose() {
    clearTimeout(this.timer);
    this.lines.clear();
  }
}

// ------------------------------------------------------------ 术语库

/** 一次最多下发的术语条数 */
export const MAX_TERMS = 10;

/**
 * 把界面上的术语表编译成火山的 corpus 参数。
 *
 * 只发两个字段：
 *
 *   hot_words_list  识别阶段  引导 ASR 听出这个词。实测有效：SensePedia 在无干预
 *                             时被认成 SensePDU，加热词后变成 Sense pedia —— 音对了，
 *                             所以 TTS 也念对了，只剩写法要修
 *   glossary_list   翻译阶段  中文术语 → 英文术语的固定对照
 *
 * 文档参数表里还有个 correct_words 替换词，但官方 proto 的 Corpus 消息**没有这个
 * 字段**，编码时会被静默丢弃（已实测确认无效）。写法层面的纠正因此改由
 * applyCorrections 在本地做。
 *
 * 一行 { text: 'SensePedia', zh: '商汤百科' } 会展开成：
 *   hot_words_list = ['SensePedia', '商汤百科']
 *   glossary_list  = { '商汤百科': 'SensePedia' }
 */
export function buildCorpus(terms = []) {
  const hot = [];
  const glossary = {};

  for (const t of terms.slice(0, MAX_TERMS)) {
    const text = String(t?.text || '').trim();
    if (!text) continue;
    hot.push(text);

    const zh = String(t?.zh || '').trim();
    if (zh) {
      hot.push(zh);
      glossary[zh] = text;
    }
  }

  const corpus = {};
  if (hot.length) corpus.hot_words_list = [...new Set(hot)];
  if (Object.keys(glossary).length) corpus.glossary_list = glossary;
  return Object.keys(corpus).length ? corpus : null;
}

/**
 * 字幕文本的术语纠正。
 *
 * 为什么需要它：火山文档的参数表里写了 `correct_words` 替换词，但官方 proto 的
 * Corpus 消息**没有这个字段**，protobuf 编码时会被静默丢弃（已实测确认）。
 * 所以文字层面的纠正只能自己做。
 *
 * 分工是清晰的：
 *   · hot_words_list 让模型把音**听对**，译音因此也念得对
 *   · 这里只把**写法**规范化，不碰音频
 *
 * 每条术语会自动派生一条"大小写 + 空格"模糊规则：填 `SensePedia` 就能同时收编
 * `Sense pedia` / `sense Pedia` / `SENSE  PEDIA`。发音层面的误识（`SensePDU`、
 * `SenseTimeedia` 这种）才需要手工补进 wrong 列表。
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把一个词变成"允许内部空白、忽略大小写"的正则 */
function fuzzy(word) {
  const parts = String(word)
    .split(/(?=[A-Z])|[\s_-]+/)   // 驼峰、空格、下划线、连字符都当分隔
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const body = parts.map(escapeRegExp).join('\\s*');
  // 前后加词边界，避免命中别的词的一部分
  const lead = /^[\w]/.test(parts[0]) ? '\\b' : '';
  const tail = /[\w]$/.test(parts[parts.length - 1]) ? '\\b' : '';
  try { return new RegExp(lead + body + tail, 'gi'); } catch { return null; }
}

const patternCache = new WeakMap();

function termPatterns(terms) {
  if (patternCache.has(terms)) return patternCache.get(terms);
  const rules = [];
  for (const t of terms.slice(0, MAX_TERMS)) {
    const right = String(t?.text || '').trim();
    if (!right) continue;
    for (const word of [right, ...(t?.wrong || [])]) {
      const re = fuzzy(word);
      if (re) rules.push([re, right]);
    }
  }
  patternCache.set(terms, rules);
  return rules;
}

export function applyCorrections(text, terms) {
  if (!text || !terms?.length) return text;
  let out = text;
  for (const [re, right] of termPatterns(terms)) {
    re.lastIndex = 0;
    out = out.replace(re, right);
  }
  return out;
}

/** base64 PCM16 的时长（毫秒） */
export function pcmDurationMs(base64, rate) {
  const bytes = Math.floor((base64.length * 3) / 4);
  return (bytes / 2 / rate) * 1000;
}

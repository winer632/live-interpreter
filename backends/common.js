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

/** 中日文字 → zh；拉丁字母 → en；纯标点数字 → null（信息不足，不改方向） */
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

  /** 依据一段源语言文本更新方向；返回方向是否真的变了 */
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
  constructor(emit, { idleMs = 1800 } = {}) {
    this.emit = emit;
    this.idleMs = idleMs;
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
    this.emit({
      t: 'line',
      id: line.id,
      dir: line.dir,
      src: line.src,
      dst: line.dst,
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

/** base64 PCM16 的时长（毫秒） */
export function pcmDurationMs(base64, rate) {
  const bytes = Math.floor((base64.length * 3) / 4);
  return (bytes / 2 / rate) * 1000;
}

/**
 * 麦克风采集 Worklet
 *
 * AudioContext 已按后端要求的采样率建立（火山 16kHz / OpenAI 24kHz），浏览器会
 * 自动把设备采样率重采样过来，这里只负责把 128 帧的渲染块攒成定长数据包。
 *
 * 即使静音也持续发包：两家的流式端点都要求连续音频流（含语句间静音），
 * 断流会影响断句判断，火山还会直接报 45000081 等包超时。
 */

class PCMCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // 火山建议 80ms 一包，OpenAI 用 40ms 延迟更低
    this.frame = options?.processorOptions?.frameSize || 960;
    this.buf = new Float32Array(this.frame);
    this.n = 0;
    this.gain = 1; // 主线程用它做防回环闸门（播放译音时压低）
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.gain === 'number') this.gain = e.data.gain;
    };
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    const g = this.gain;

    for (let i = 0; i < 128; i++) {
      this.buf[this.n++] = ch ? ch[i] * g : 0;
      if (this.n === this.frame) {
        let peak = 0;
        for (let k = 0; k < this.frame; k++) {
          const a = this.buf[k] < 0 ? -this.buf[k] : this.buf[k];
          if (a > peak) peak = a;
        }
        this.port.postMessage({ pcm: this.buf.slice(), peak });
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PCMCapture);

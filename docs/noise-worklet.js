// AudioWorklet processor: batches microphone samples into fixed-size chunks
// and posts them to the main thread together with the audio-clock frame index
// of the first sample. The main thread converts that index to wall-clock time,
// so event timestamps stay accurate even if the page thread is throttled.
class NoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 1024;
    this.buf = new Float32Array(this.chunkSize);
    this.fill = 0;
    this.chunkStartFrame = currentFrame;
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      if (this.fill === 0) this.chunkStartFrame = currentFrame + i;
      this.buf[this.fill++] = ch[i];
      if (this.fill === this.chunkSize) {
        const out = this.buf;
        this.port.postMessage({ samples: out, frame: this.chunkStartFrame }, [out.buffer]);
        this.buf = new Float32Array(this.chunkSize);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('noise-processor', NoiseProcessor);

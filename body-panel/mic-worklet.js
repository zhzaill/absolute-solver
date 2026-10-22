class SolverCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.target = Math.max(160, Math.round(sampleRate * 0.02));
    this.frame = new Float32Array(this.target);
    this.offset = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const length = channels[0]?.length ?? 0;
    for (let index = 0; index < length; index += 1) {
      let value = 0;
      for (const channel of channels) value += channel[index] || 0;
      this.frame[this.offset++] = value / channels.length;
      if (this.offset < this.target) continue;

      const pcm = new Int16Array(this.target);
      let energy = 0;
      for (let sample = 0; sample < this.target; sample += 1) {
        const normalized = Math.max(-1, Math.min(1, this.frame[sample]));
        energy += normalized * normalized;
        pcm[sample] = normalized < 0
          ? Math.round(normalized * 0x8000)
          : Math.round(normalized * 0x7fff);
      }
      const rms = Math.sqrt(energy / this.target);
      this.port.postMessage({ pcm: pcm.buffer, rms, sampleRate }, [pcm.buffer]);
      this.offset = 0;
    }
    return true;
  }
}

registerProcessor('solver-capture', SolverCaptureProcessor);

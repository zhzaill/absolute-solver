// TTS playback + mouth levels for the face model. One analyser feeds the level
// meter, so the figure's mouth follows whatever audio is actually playing.
export function createVoicePlayer({ onLevel = () => {}, onState = () => {} } = {}) {
  let ctx = null;
  let analyser = null;
  let samples = null;
  let raf = 0;
  let source = null;
  let generation = 0;

  function ensureContext() {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      ctx = new Ctor({ latencyHint: 'interactive' });
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.55;
      analyser.connect(ctx.destination);
      samples = new Float32Array(analyser.fftSize);
    }
    return ctx;
  }

  function meter() {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    onLevel(Math.min(1, rms * 6));
    raf = requestAnimationFrame(meter);
  }

  function stopSource() {
    if (source) {
      try { source.onended = null; source.stop(); } catch { /* already stopped */ }
      source = null;
    }
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    onLevel(0);
  }

  async function unlock() {
    const context = ensureContext();
    if (context.state === 'suspended') { try { await context.resume(); } catch { /* ignore */ } }
    return context.state;
  }

  async function play(url) {
    const token = ++generation;
    const context = ensureContext();
    if (context.state === 'suspended') { try { await context.resume(); } catch { /* autoplay blocked */ } }
    onState('loading');
    let response;
    try {
      response = await fetch(url, { cache: 'no-store' });
    } catch (error) {
      onState('error', error.message);
      return;
    }
    if (!response.ok) { onState('error', `audio ${response.status}`); return; }
    const buffer = await response.arrayBuffer();
    if (token !== generation) return;
    let audio;
    try {
      audio = await context.decodeAudioData(buffer.slice(0));
    } catch (error) {
      onState('error', 'decode failed');
      return;
    }
    if (token !== generation) return;
    stopSource();
    const node = context.createBufferSource();
    node.buffer = audio;
    node.connect(analyser);
    node.onended = () => { if (token === generation) { stopSource(); onState('idle'); } };
    source = node;
    onState('playing');
    node.start();
    if (!raf) meter();
  }

  return {
    unlock,
    play,
    stop: () => { generation += 1; stopSource(); onState('idle'); },
    get playing() { return Boolean(source); },
  };
}

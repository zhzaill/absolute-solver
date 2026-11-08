// Shared client for both projections: SSE downlink from the bridge, HTTPS uplink
// into the same Persona, and host ASR. No UI, no settings — that stays on the host.

const MAX_TEXT = 500;

export function createFaceClient({
  onReady = () => {},
  onMessage = () => {},
  onCue = () => {},
  onVoice = () => {},
  onError = () => {},
  onTranscript = () => {},
} = {}) {
  let source = null;
  let lastUser = { text: '', at: 0 };

  function connect({ role = 'chat' } = {}) {
    close();
    const es = new EventSource(`/face/events?role=${encodeURIComponent(role)}`);
    source = es;

    es.addEventListener('hello', () => onReady(true));
    es.addEventListener('open', () => onReady(true));
    es.addEventListener('error', (event) => {
      // Both transport errors (no data) and bridge `error` frames land here.
      let data = null;
      try { data = JSON.parse(event.data); } catch { /* transport */ }
      if (data) onError(data);
      else onReady(false);
    });

    es.addEventListener('message', (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.role === 'user') {
        const now = Date.now();
        if (data.text === lastUser.text && now - lastUser.at < 8000) return;
        onMessage({ ...data, role: 'user' });
        return;
      }
      onMessage(data);
    });

    es.addEventListener('cue', (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      onCue(data);
    });

    es.addEventListener('voice', (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.url) onVoice(data);
    });

    es.addEventListener('transcript', (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      onTranscript(data);
    });

    return es;
  }

  function close() {
    try { source?.close(); } catch { /* ignore */ }
    source = null;
  }

  /** Sends text into the shared Persona. Returns {ok,error}. */
  async function say(text) {
    const value = String(text || '').trim().slice(0, MAX_TEXT);
    if (!value) return { ok: false, error: 'empty' };
    lastUser = { text: value, at: Date.now() };
    try {
      const response = await fetch('/face/say', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: value }),
      });
      const data = await response.json().catch(() => ({}));
      return response.ok ? { ok: true } : { ok: false, error: data.error || `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /** Records the mic, converts to 16 kHz mono WAV, and asks the host ASR. */
  function createRecorder({ onState = () => {} } = {}) {
    let recorder = null;
    let chunks = [];
    let stream = null;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('此浏览器不支持麦克风');
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((item) => window.MediaRecorder?.isTypeSupported?.(item)) || '';
      recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
      chunks = [];
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
      recorder.start();
      onState('recording');
    }

    function stop() {
      return new Promise((resolve) => {
        if (!recorder) { resolve(null); return; }
        recorder.addEventListener('stop', async () => {
          stream?.getTracks().forEach((track) => track.stop());
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          chunks = [];
          onState('transcribing');
          try {
            const wav = await toWav16k(blob);
            const response = await fetch('/face/asr', {
              method: 'POST',
              headers: { 'content-type': 'audio/wav' },
              body: wav,
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.text) throw new Error(data.error || `HTTP ${response.status}`);
            onState('idle');
            resolve(String(data.text));
          } catch (error) {
            onState('error');
            resolve({ error: error.message });
          }
        }, { once: true });
        try { recorder.stop(); } catch { resolve(null); }
      });
    }

    return {
      start,
      stop,
      get recording() { return recorder?.state === 'recording'; },
    };
  }

  return { connect, close, say, createRecorder };
}

async function toWav16k(blob) {
  const array = await blob.arrayBuffer();
  const Ctor = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctor();
  let decoded;
  try { decoded = await ctx.decodeAudioData(array.slice(0)); } finally { ctx.close?.(); }
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}

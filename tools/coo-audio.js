// Keep Coo's original pet page as the UI. This adapter only delivers new tts.voice audio to the browser.
let cursor = null;
let context = null;
let unlocked = false;
let active = null;
const queue = [];

function unlock() {
  if (!context) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) context = new AudioContext();
  }
  if (!context) return;
  context.resume().then(() => { unlocked = true; void drain(); }).catch(() => {});
}

async function drain() {
  if (!unlocked || active || !queue.length || !context) return;
  const item = queue.shift();
  try {
    const bytes = await (await fetch(item.url, { cache: 'no-store' })).arrayBuffer();
    const buffer = await context.decodeAudioData(bytes);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    active = source;
    source.onended = () => { active = null; void drain(); };
    source.start();
  } catch {
    active = null;
    void drain();
  }
}

async function poll() {
  try {
    const path = cursor === null ? '/api/coo/audio' : `/api/coo/audio?after=${encodeURIComponent(cursor)}`;
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (cursor === null) {
      cursor = Number.isSafeInteger(payload.nextAfter) ? payload.nextAfter : Number(payload.latest) || 0;
    } else {
      for (const voice of payload.voices || []) queue.push(voice);
      cursor = Number.isSafeInteger(payload.nextAfter) ? payload.nextAfter : cursor;
      void drain();
    }
  } catch {
    // The pet page stays usable when Cortico is temporarily offline.
  } finally {
    window.setTimeout(poll, 1200);
  }
}

for (const event of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(event, unlock, { capture: true, passive: true });
void poll();

// Second projection: the character only. No buttons, no chat, no settings.
// It receives cues and TTS audio over the same SSE bridge and speaks on its own.
import { mountLive2D } from './render-live2d.js';
import { createVoicePlayer } from './face-audio.js';
import { createFaceClient } from './face-client.js';

const stage = document.getElementById('stage');

// Desktop-pet host (tools/face-window): the whole body becomes the drag handle,
// and Esc closes the window. No visible controls either way.
if (navigator.userAgent.includes('Electron')) {
  document.body.classList.add('electron');
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.close(); });
}

const mouth = (() => {
  let level = 0;
  let raf = 0;
  let active = false;
  let renderer = null;
  const tick = () => {
    renderer?.setMouth(level);
    raf = active ? requestAnimationFrame(tick) : 0;
  };
  return {
    bind(next) { renderer = next; },
    set(value) {
      level = Math.max(0, Math.min(1, value));
      if (!active) { active = true; if (!raf) raf = requestAnimationFrame(tick); }
    },
    stop() { active = false; level = 0; renderer?.setMouth(0); },
  };
})();

const player = createVoicePlayer({
  onLevel: (value) => mouth.set(value),
  onState: (kind) => { if (kind !== 'playing') mouth.stop(); },
});

function unlockAudio() { player.unlock().catch(() => {}); }
document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });

createFaceClient({
  onVoice: (data) => {
    unlockAudio();
    player.play(data.url).catch(() => {});
  },
  onCue: (data) => {
    if (data.kind === 'expression' && data.id) globalThis.__faceRenderer?.do(data.id);
  },
}).connect({ role: 'figure' });

async function boot() {
  let models = [];
  let chosen = null;
  try {
    const response = await fetch('/face/models', { cache: 'no-store' });
    const data = await response.json();
    models = Array.isArray(data.models) ? data.models : [];
    const wanted = new URLSearchParams(location.search).get('model') || localStorage.getItem('face.model');
    chosen = models.find((item) => item.id === wanted) || models.find((item) => item.id === data.default) || models[0];
  } catch { /* keep empty */ }
  if (!chosen) return;

  const base = new URL(chosen.root, location.href).href;
  const renderer = await mountLive2D({ root: stage, packUrl: base, model: chosen.model || chosen.id });
  globalThis.__faceRenderer = renderer;
  mouth.bind(renderer);
}

boot().catch((error) => console.error('[figure]', error));

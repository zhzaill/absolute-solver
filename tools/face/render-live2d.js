// Standalone Live2D face renderer for the projection main window.
//
// It drives the Coo figure pack (copied into live2d/pack by sync-face-assets.mjs)
// without the sandboxed /figure-frame: same origin, same CSP, no iframe. The kit
// body is scaled far past the viewport bottom and the stage clips the overflow,
// so the window shows head and upper torso instead of the whole figure.
import { clamp } from './face-util.js';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    if (new URL(url, document.baseURI).origin !== location.origin) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image failed: ${url}`));
    img.src = String(url);
  });
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root stage element the figure is drawn into
 * @param {string} [opts.packUrl] pack directory URL ending in '/'
 * @param {string} [opts.model] scheme/model id inside the pack
 * @param {(kind:string, detail:any)=>void} [opts.onEvent]
 */
export async function mountLive2D({ root, packUrl = new URL('./live2d/pack/', import.meta.url), model = 'deepseek', onEvent = () => {} }) {
  const kit = await import('./live2d/kit/body.js');
  const { createFigureBody } = await import(/* @vite-ignore */ `${packUrl}figure.js`);

  // The kit works in logo units (256 square, feet at y=256). Its walk bounds cap S
  // at roughly (W-16)/208, so a large S alone cannot zoom into the upper body.
  // Instead keep S kit-safe and scale the whole figure with CSS: the stage clips
  // everything below the waist. CROWN..WAIST is the logo range we want visible.
  const CROWN = 23;
  const WAIST = 126;
  const geometry = () => {
    const W = Math.max(1, root.clientWidth);
    const H = Math.max(1, root.clientHeight);
    const S = ((W - 16) / 208) * 0.96;
    const zoom = clamp((0.94 * H) / (107 * S), 1, 3.4);
    const floorY = (H * 0.06) / zoom + (256 - CROWN) * S;
    return { W, H, floorY, S, zoom };
  };

  let appliedZoom = 0;
  const applyZoom = (zoom) => {
    if (Math.abs(zoom - appliedZoom) < 0.001) return;
    appliedZoom = zoom;
    root.style.transformOrigin = '50% 0';
    root.style.transform = `scale(${zoom.toFixed(4)})`;
  };

  // Keep the model's own centre on the stage centre: the pack extent is not
  // symmetric around logo x=128, so raw pet.x would sit a little to one side.
  const centreX = () => {
    const { W } = geometry();
    try {
      const layout = body.layout();
      return layout.x + (W / 2 - (layout.box.x + layout.box.w / 2));
    } catch {
      return W / 2;
    }
  };

  const host = {
    root,
    bounds: geometry,
    emit: (kind, detail) => onEvent(kind, detail),
    sound: () => {},
    start: { x: Math.max(1, root.clientWidth) / 2, facing: 1, skin: null },
  };

  const body = await createFigureBody(new URL(packUrl), { kit, host, model, scheme: model, loadImage });
  body.set({ roam: 'off' });
  body.place(geometry().W / 2, 1);
  const drive = () => globalThis.__l2dDrive;
  let mouth = 0;
  let last = performance.now();
  let raf = 0;
  let disposed = false;

  function frame(now) {
    if (disposed) return;
    const dt = clamp((now - last) / 1000, 0, 0.05);
    last = now;
    try {
      applyZoom(geometry().zoom);
      body.place(centreX(), 1);
      body.step(dt);
    } catch (error) {
      console.warn('[face] step failed', error);
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  // Re-place after a resize so the figure stays centred without waiting for the kit roam state.
  const onResize = () => body.place(centreX(), 1);
  window.addEventListener('resize', onResize);

  return {
    body,
    do(word) { try { body.do(word); } catch { /* unknown word */ } },
    /** 0..1 mouth opening, overriding the idle pose while TTS plays. */
    setMouth(value) {
      const next = clamp(Number(value) || 0, 0, 1);
      mouth = next;
      const api = drive();
      if (api?.set) api.set({ mouthOpen: next });
    },
    getMouth: () => mouth,
    clearMouth() { const api = drive(); if (api?.clear) api.clear(); mouth = 0; },
    destroy() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      try { body.dispose(); } catch { /* ignore */ }
    },
  };
}

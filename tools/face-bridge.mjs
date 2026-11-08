// Face window bridge: SSE downlink from Cortico, HTTPS uplink into the same Coo
// Persona, host ASR for voice input, and Live2D model import.
//
// The window never talks to Coo or Cortico directly; it only knows this server.
// Uplink uses a Coo *watcher* socket (`role=pet&host=tab`) so the desktop pet
// window keeps ownership: watchers may send text but never binary mic frames.
import { readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, dirname, join, resolve, sep } from 'node:path';

const AUDIO_MIME = /^audio\//;
const MAX_TEXT = 500;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const RING = 200;

function readAll(request, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error(`payload too large (${limit} bytes)`)); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response, status, value) {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function withinRoot(root, target) {
  const rel = resolve(target).slice(resolve(root).length);
  return resolve(target).startsWith(resolve(root) + sep) || rel === '';
}

export function createFaceBridge({
  cooBaseUrl,
  corticoBaseUrl,
  asrBaseUrl = new URL('http://127.0.0.1:9881'),
  faceRoot,
  ttsHandles,
  WebSocket,
  log = console,
}) {
  const modelsFile = join(faceRoot, 'models.json');
  const packsRoot = join(faceRoot, 'live2d', 'packs');
  const importsRoot = join(faceRoot, 'live2d', 'imports');
  const converter = join(faceRoot, 'import', 'convert.mjs');
  const runtimePack = join(faceRoot, 'live2d', 'pack');

  // response -> { role } where role is 'chat' or 'figure'. The figure page owns
  // audio playback; only one of them speaks at a time so two open figure tabs
  // cannot echo the same TTS clip.
  const clients = new Map();
  let audioOwner = null;
  const ring = [];
  let nextFrom = null;
  let pollTimer = null;
  let polling = false;

  // ---------------------------------------------------------------- Coo uplink
  let coo = null;
  let cooReady = false;

  function cooUrl() {
    const url = new URL('/socket?role=pet&host=tab', cooBaseUrl);
    url.protocol = cooBaseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    return url;
  }

  function connectCoo() {
    if (!WebSocket) return null;
    if (coo && (coo.readyState === 0 || coo.readyState === 1)) return coo;
    try {
      coo = new WebSocket(cooUrl().href, { origin: cooBaseUrl.origin });
    } catch (error) {
      log.warn(`[face] watcher socket failed: ${error.message}`);
      coo = null;
      return null;
    }
    cooReady = false;
    coo.on('open', () => { cooReady = true; });
    coo.on('error', (error) => log.warn(`[face] watcher socket: ${error.message}`));
    coo.on('close', () => { cooReady = false; coo = null; });
    return coo;
  }

  async function say(text) {
    const socket = connectCoo();
    if (!socket) return { ok: false, error: 'Coo socket unavailable' };
    const open = await new Promise((resolveOpen) => {
      if (socket.readyState === 1) { resolveOpen(true); return; }
      if (socket.readyState > 1) { resolveOpen(false); return; }
      const done = (value) => {
        clearTimeout(timer);
        socket.off?.('open', onOpen); socket.off?.('error', onFail); socket.off?.('close', onFail);
        resolveOpen(value);
      };
      const onOpen = () => done(true);
      const onFail = () => done(false);
      const timer = setTimeout(() => done(false), 3000);
      socket.once('open', onOpen); socket.once('error', onFail); socket.once('close', onFail);
    });
    if (!open) return { ok: false, error: 'Coo not reachable' };
    try {
      socket.send(JSON.stringify({ t: 'text', text }));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  // ---------------------------------------------------------------- Cortico down
  const frame = (event) => `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

  function drop(client) {
    clients.delete(client);
    if (audioOwner === client) audioOwner = null;
  }

  function sendTo(client, event) {
    try { client.write(frame(event)); return true; } catch { drop(client); return false; }
  }

  function pickOwner() {
    if (audioOwner && clients.has(audioOwner)) return audioOwner;
    audioOwner = null;
    for (const [client, meta] of clients) if (meta.role === 'figure') { audioOwner = client; break; }
    return audioOwner;
  }

  function publish(event) {
    ring.push(event);
    while (ring.length > RING) ring.shift();
    if (event.type === 'voice') {
      const owner = pickOwner();
      if (owner) sendTo(owner, event);
      return;
    }
    for (const [client, meta] of clients) {
      if (event.type === 'cue' && meta.role !== 'figure') continue;
      sendTo(client, event);
    }
  }

  function mapEvent(event) {
    const out = [];
    const cursor = Number(event.cursor) || 0;
    if (event.type === 'desktop-pet.self' && event.meta?.kind === 'say') {
      const beats = Array.isArray(event.meta.beats) ? event.meta.beats : [];
      const text = beats.map((beat) => String(beat?.text || '')).filter(Boolean).join('\n') || String(event.text || '');
      const mood = beats.find((beat) => beat?.mood?.id)?.mood?.id || null;
      if (text) out.push({ type: 'message', cursor, role: 'assistant', kind: 'say', text, mood, ts: event.ts });
      if (mood) out.push({ type: 'cue', cursor, kind: 'expression', id: mood });
    } else if (event.type === 'desktop-pet.message') {
      const text = String(event.meta?.text || '').trim();
      if (text) out.push({ type: 'message', cursor, role: 'user', kind: 'say', text, ts: event.ts });
    } else if (event.type === 'tts.voice') {
      for (const blob of Array.isArray(event.blobs) ? event.blobs : []) {
        if (typeof blob?.handle !== 'string' || typeof blob?.mime !== 'string' || !AUDIO_MIME.test(blob.mime)) continue;
        ttsHandles?.add(blob.handle);
        while (ttsHandles && ttsHandles.size > 1000) ttsHandles.delete(ttsHandles.values().next().value);
        out.push({ type: 'voice', cursor, url: `/api/coo/blob?handle=${encodeURIComponent(blob.handle)}`, mime: blob.mime });
      }
    } else if (event.type === 'tts.voice-failed') {
      out.push({ type: 'error', cursor, code: 'tts', message: String(event.text || '语音合成失败') });
    }
    return out;
  }

  async function latestCursor() {
    const response = await fetch(new URL('/api/events?limit=1', corticoBaseUrl), { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) throw new Error(`Cortico HTTP ${response.status}`);
    const payload = await response.json();
    return Number(payload.latest) || 0;
  }

  let lastPollError = '';

  async function poll() {
    pollTimer = null;
    if (polling) return;
    if (!clients.size) { schedulePoll(1500); return; }
    polling = true;
    try {
      if (nextFrom === null) nextFrom = (await latestCursor()) + 1;
      const url = new URL(`/api/events?from=${nextFrom}&limit=40&archive=1`, corticoBaseUrl);
      const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'error' });
      if (!response.ok) throw new Error(`Cortico HTTP ${response.status}`);
      const payload = await response.json();
      const events = Array.isArray(payload.events) ? payload.events : [];
      for (const event of events) {
        const cursor = Number(event.cursor) || 0;
        if (cursor >= nextFrom) nextFrom = cursor + 1;
        for (const mapped of mapEvent(event)) publish(mapped);
      }
      const latest = Number(payload.latest) || 0;
      if (!events.length && latest + 1 > nextFrom) nextFrom = latest + 1;
      lastPollError = '';
    } catch (error) {
      const message = error.message;
      if (clients.size && message !== lastPollError) {
        log.warn(`[face] poll: ${message}`);
        lastPollError = message;
      }
    } finally {
      polling = false;
      schedulePoll(700);
    }
  }

  function schedulePoll(delay) {
    if (pollTimer || !clients.size) return;
    pollTimer = setTimeout(() => { poll().catch(() => {}); }, delay);
    pollTimer.unref?.();
  }

  async function sse(request, response) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write('retry: 2000\n\n');
    const role = new URL(request.url, 'http://localhost').searchParams.get('role') === 'figure' ? 'figure' : 'chat';
    clients.set(response, { role });
    if (role === 'figure') pickOwner();
    const resume = Number(request.headers['last-event-id']);
    if (Number.isFinite(resume) && resume > 0) {
      for (const event of ring) {
        if (event.cursor <= resume) continue;
        if (event.type === 'cue' && role !== 'figure') continue;
        if (event.type === 'voice' && audioOwner !== response) continue;
        response.write(frame(event));
      }
    }
    response.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString(), pet: Boolean(cooReady) })}\n\n`);
    const heartbeat = setInterval(() => { try { response.write(':\n\n'); } catch { /* ignore */ } }, 15000);
    heartbeat.unref?.();
    const cleanup = () => { clearInterval(heartbeat); drop(response); };
    request.on('close', cleanup);
    response.on('close', cleanup);
    response.on('error', cleanup);
    schedulePoll(0);
  }

  // ---------------------------------------------------------------- ASR
  async function transcribe(buffer) {
    const form = new FormData();
    form.set('file', new Blob([buffer], { type: 'audio/wav' }), 'speech.wav');
    form.set('model', process.env.SOLVER_ASR_MODEL || 'whisper-1');
    const response = await fetch(new URL('/v1/audio/transcriptions', asrBaseUrl), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(45000),
    });
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* non-json */ }
    if (!response.ok) throw new Error(data.error?.message || data.message || `ASR HTTP ${response.status}`);
    const picked = data.text ?? data.transcription ?? data.result?.text ?? data.data?.text ?? '';
    if (!picked) throw new Error('ASR returned no text');
    return String(picked).trim();
  }

  // ---------------------------------------------------------------- models
  async function readRegistry() {
    try { return JSON.parse(await readFile(modelsFile, 'utf8')); } catch { return null; }
  }

  async function registry() {
    const stored = await readRegistry();
    if (stored?.models) return stored;
    return {
      default: 'deepseek',
      models: [{ id: 'deepseek', label: 'DeepSeek 大肥鱼', root: '/face/live2d/pack/', model: 'deepseek', builtin: true }],
    };
  }

  async function writeRegistry(data) {
    await mkdir(dirname(modelsFile), { recursive: true });
    await writeFile(modelsFile, JSON.stringify(data, null, 2), 'utf8');
  }

  function runConverter(modelDir, id) {
    return new Promise((resolveRun) => {
      const out = join(packsRoot, id);
      const args = [converter, '--model', modelDir, '--out', out, '--id', id, '--runtime', runtimePack, '--max-texture', '2048', '--force'];
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: dirname(converter) });
      let output = '';
      const cap = (chunk) => { output += chunk.toString(); if (output.length > 8000) output = output.slice(-8000); };
      child.stdout.on('data', cap);
      child.stderr.on('data', cap);
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 180000);
      child.on('error', (error) => { clearTimeout(timer); resolveRun({ ok: false, output: error.message }); });
      child.on('close', async (code) => {
        clearTimeout(timer);
        if (code !== 0) return resolveRun({ ok: false, output });
        // The base64 moc3 fallback is unused once fetch works; drop the 20+ MB copy.
        try { await rm(join(out, 'models', id, 'moc3.js'), { force: true }); } catch { /* ignore */ }
        resolveRun({ ok: true, output, out });
      });
    });
  }

  async function importFromPath(modelDir, id, label) {
    if (!existsSync(modelDir)) return { ok: false, error: `路径不存在：${modelDir}` };
    const result = await runConverter(modelDir, id);
    if (!result.ok) return result;
    const data = await registry();
    data.models = (data.models || []).filter((item) => item.id !== id);
    data.models.push({ id, label: label || id, root: `/face/live2d/packs/${id}/`, model: id, builtin: false });
    await writeRegistry(data);
    return { ok: true, id, root: `/face/live2d/packs/${id}/` };
  }

  // ---------------------------------------------------------------- routing
  async function handle(request, response, pathname) {
    const url = new URL(request.url || '/', 'http://face');

    if (pathname === '/face/events' && request.method === 'GET') { await sse(request, response); return true; }

    if (pathname === '/face/status' && request.method === 'GET') {
      let asr = 'unknown';
      try {
        const probe = await fetch(new URL('/v1/models', asrBaseUrl), { signal: AbortSignal.timeout(1200) });
        asr = probe.ok || probe.status === 404 ? 'online' : `http-${probe.status}`;
      } catch { asr = 'offline'; }
      sendJson(response, 200, { ok: true, pet: Boolean(cooReady), clients: clients.size, figures: [...clients.values()].filter((meta) => meta.role === 'figure').length, asr });
      return true;
    }

    if (pathname === '/face/say' && request.method === 'POST') {
      let body;
      try { body = JSON.parse((await readAll(request, MAX_TEXT * 8)).toString('utf8')); } catch { sendJson(response, 400, { error: 'invalid json' }); return true; }
      const text = String(body?.text || '').trim().slice(0, MAX_TEXT);
      if (!text) { sendJson(response, 400, { error: 'empty text' }); return true; }
      const result = await say(text);
      sendJson(response, result.ok ? 202 : 503, result);
      return true;
    }

    if (pathname === '/face/asr' && request.method === 'POST') {
      let audio;
      try { audio = await readAll(request, MAX_AUDIO_BYTES); } catch (error) { sendJson(response, 413, { error: error.message }); return true; }
      if (audio.length < 800) { sendJson(response, 400, { error: 'audio too short' }); return true; }
      try {
        const text = await transcribe(audio);
        sendJson(response, 200, { ok: true, text });
      } catch (error) {
        sendJson(response, 503, { ok: false, error: error.message });
      }
      return true;
    }

    if (pathname === '/face/models' && request.method === 'GET') {
      const data = await registry();
      sendJson(response, 200, data);
      return true;
    }

    if (pathname === '/face/models/import-path' && request.method === 'POST') {
      let body;
      try { body = JSON.parse((await readAll(request, 8192)).toString('utf8')); } catch { sendJson(response, 400, { error: 'invalid json' }); return true; }
      const modelDir = String(body?.path || '').trim();
      if (!modelDir) { sendJson(response, 400, { error: 'path required' }); return true; }
      const id = String(body?.id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '') || `model${Date.now().toString(36)}`;
      const result = await importFromPath(resolve(modelDir), id, body?.label);
      sendJson(response, result.ok ? 200 : 500, result);
      return true;
    }

    // Incremental folder upload: POST one file per request with its relative path.
    if (pathname === '/face/models/upload' && request.method === 'POST') {
      const id = String(url.searchParams.get('id') || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const rel = String(url.searchParams.get('path') || '');
      const finish = url.searchParams.get('finish') === '1';
      if (!id) { sendJson(response, 400, { error: 'id required' }); return true; }
      const target = resolve(importsRoot, id);
      if (!withinRoot(importsRoot, target)) { sendJson(response, 400, { error: 'bad id' }); return true; }
      if (finish) {
        const info = await findModelDir(target);
        if (!info) { sendJson(response, 400, { error: 'no .model3.json in upload' }); return true; }
        const result = await importFromPath(info.dir, id, url.searchParams.get('label') || id);
        sendJson(response, result.ok ? 200 : 500, result);
        return true;
      }
      if (!rel) { sendJson(response, 400, { error: 'path required' }); return true; }
      const filePath = resolve(target, rel);
      if (!withinRoot(target, filePath)) { sendJson(response, 400, { error: 'path escapes upload dir' }); return true; }
      let data;
      try { data = await readAll(request, MAX_UPLOAD_BYTES); } catch (error) { sendJson(response, 413, { error: error.message }); return true; }
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, data);
      sendJson(response, 200, { ok: true, bytes: data.length });
      return true;
    }

    if (pathname === '/face/models/remove' && request.method === 'POST') {
      let body;
      try { body = JSON.parse((await readAll(request, 4096)).toString('utf8')); } catch { sendJson(response, 400, { error: 'invalid json' }); return true; }
      const id = String(body?.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const data = await registry();
      const entry = (data.models || []).find((item) => item.id === id);
      if (!entry || entry.builtin) { sendJson(response, 400, { error: 'cannot remove builtin or unknown model' }); return true; }
      data.models = data.models.filter((item) => item.id !== id);
      if (data.default === id) data.default = data.models[0]?.id || 'deepseek';
      await writeRegistry(data);
      try { await rm(join(packsRoot, id), { recursive: true, force: true }); } catch { /* ignore */ }
      sendJson(response, 200, { ok: true });
      return true;
    }

    return false;
  }

  async function findModelDir(root) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      const model = entries.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.model3.json'));
      if (model) return { dir, file: model.name };
      for (const entry of entries) if (entry.isDirectory()) stack.push(join(dir, entry.name));
    }
    return null;
  }

  function close() {
    if (pollTimer) clearTimeout(pollTimer);
    for (const client of clients.keys()) { try { client.end(); } catch { /* ignore */ } }
    clients.clear();
    audioOwner = null;
    try { coo?.close(); } catch { /* ignore */ }
  }

  return {
    handle,
    close,
    say,
    get listening() { return clients.size; },
    async ready() {
      const data = await registry();
      await mkdir(packsRoot, { recursive: true });
      await mkdir(importsRoot, { recursive: true });
      return { models: data.models.map((item) => ({ id: item.id, label: item.label, root: item.root, model: item.model })), default: data.default, converterReady: existsSync(converter) };
    },
  };
}

export { AUDIO_MIME, withinRoot };

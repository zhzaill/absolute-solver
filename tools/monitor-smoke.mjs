import http from 'node:http';

const modelPort = Number(process.env.MODEL_PORT || 19090);
const hubUrl = process.env.HUB_URL || 'http://127.0.0.1:18198';
const modelUrl = `http://127.0.0.1:${modelPort}`;
const startedAt = Date.now();

function wav(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function tone(sequence) {
  const pcm = Buffer.alloc(1600);
  for (let index = 0; index < pcm.length; index += 2) {
    const sample = Math.sin((index / 2 + sequence * 3) / 8) * 7000;
    pcm.writeInt16LE(Math.trunc(sample), index);
  }
  return wav(pcm);
}

function json(response, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', modelUrl);
  if (request.method === 'GET' && ['/health', '/healthz', '/v1/models'].includes(url.pathname)) {
    return json(response, { ok: true, upstream_alive: true });
  }
  if (request.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
    request.resume();
    return json(response, { text: '监视器链路测试' });
  }
  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    request.resume();
    return json(response, {
      choices: [{ message: { content: '我已经收到全链路测试信号。' } }],
      usage: { prompt_tokens: 18, completion_tokens: 12, total_tokens: 30 },
    });
  }
  if (request.method === 'POST' && url.pathname === '/v1/audio/speech') {
    request.resume();
    const body = tone(Math.floor(Date.now() / 1000) % 10);
    response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': body.length });
    return response.end(body);
  }
  if (request.method === 'GET' && url.pathname === '/api/status') {
    return json(response, {
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      modelConnection: { name: 'mock-openai', model: 'monitor-smoke' },
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/usage') {
    return json(response, {
      currency: 'USD',
      totals: {
        calls: 12,
        promptTokens: 420,
        completionTokens: 188,
        cacheHitTokens: 64,
        cost: 0.0012,
      },
      ledger: { error: null },
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/log') {
    return json(response, []);
  }
  response.writeHead(404).end();
});

await new Promise(resolve => server.listen(modelPort, '127.0.0.1', resolve));

let ws = null;
let currentTurn = 0;
let audioSequence = 0;
let corticoSequence = 0;
const source = `monitor-smoke-${process.pid}`;
const session = `session-${process.pid}`;

async function post(path, body) {
  const response = await fetch(`${hubUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`${path} -> ${response.status}: ${await response.text()}`);
  }
}

async function sendBodyTurn() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  currentTurn += 1;
  for (let index = 0; index < 3; index += 1) {
    const pcm = Buffer.alloc(320);
    ws.send(JSON.stringify({
      v: 1,
      type: 'audio.up',
      turn: currentTurn,
      seq: audioSequence++,
      pcm_b64: pcm.toString('base64'),
      sr: 16000,
    }));
  }
  ws.send(JSON.stringify({ v: 1, type: 'speech.end', turn: currentTurn, at_ms: Date.now() }));
}

async function sendCorticoEvent() {
  corticoSequence += 1;
  const kinds = ['world.event', 'world.tool_result', 'subtitle'];
  const kind = kinds[corticoSequence % kinds.length];
  await post('/cortico/event', {
    v: 1,
    type: kind,
    session_id: session,
    turn_id: String(currentTurn),
    seq: corticoSequence,
    ts_mono_ms: Date.now(),
    source,
    payload: { text: `smoke ${kind}`, priority: 'low' },
  });
}

async function touchMemory() {
  const text = `链路测试记忆 ${new Date().toISOString()}`;
  const response = await fetch(`${hubUrl}/memory/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'smoke',
      text,
      importance: 0.2,
      source: 'monitor-smoke',
    }),
  });
  if (!response.ok) throw new Error(`/memory/write -> ${response.status}`);
  const written = await response.json();
  await fetch(`${hubUrl}/memory/search?q=${encodeURIComponent('链路测试')}&limit=3`);
  await fetch(`${hubUrl}/memory/${written.id}`, { method: 'DELETE' });
}

const state = await (await fetch(`${hubUrl}/state`)).json();
currentTurn = Number(state.turn || 0);
const socketUrl = `${hubUrl.replace(/^http/, 'ws')}/ws`;
ws = new WebSocket(socketUrl);

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({
    v: 1,
    type: 'hello',
    device_id: 'monitor-smoke-body',
    caps: { mic: true, speaker: true, display: 'subtitle', codec: ['pcm16'] },
  }));
  setTimeout(() => sendBodyTurn().catch(console.error), 300);
  setInterval(() => sendBodyTurn().catch(console.error), 4000);
});
ws.addEventListener('error', error => console.error('websocket error', error.message));
ws.addEventListener('close', () => console.error('websocket closed'));

setInterval(() => sendCorticoEvent().catch(console.error), 1200);
setInterval(() => touchMemory().catch(console.error), 5000);
console.log(JSON.stringify({ modelUrl, hubUrl, socketUrl, pid: process.pid }));

function shutdown() {
  try { ws?.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

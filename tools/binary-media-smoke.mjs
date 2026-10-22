import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.SMOKE_PORT || 18197);
const baseUrl = `http://127.0.0.1:${port}`;
const wsUrl = `ws://127.0.0.1:${port}/ws`;
const hubBinary = process.env.HUB_BINARY || path.resolve('target/release/absolute-solver-hub.exe');
const tracePath = path.join(os.tmpdir(), `absolute-solver-binary-${process.pid}.jsonl`);

if (!fs.existsSync(hubBinary)) throw new Error(`hub binary not found: ${hubBinary}`);

const hub = spawn(hubBinary, [], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SOLVER_HUB_LISTEN: `127.0.0.1:${port}`,
    SOLVER_TRACE: tracePath,
    SOLVER_MEMORY_DB: ':memory:',
    SOLVER_ASR_URL: '',
    SOLVER_TTS_URL: '',
    SOLVER_LLM_URL: '',
    SOLVER_CORTICO_MONITOR_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
hub.stdout.on('data', chunk => { output += String(chunk); });
hub.stderr.on('data', chunk => { output += String(chunk); });

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function frame(kind, turn, seq, sampleRate, pcm) {
  const bytes = new Uint8Array(28 + pcm.byteLength);
  bytes.set([0x41, 0x53, 0x56, 0x31], 0);
  bytes[4] = 1;
  bytes[5] = kind;
  const view = new DataView(bytes.buffer);
  view.setBigUint64(8, BigInt(turn), true);
  view.setBigUint64(16, BigInt(seq), true);
  view.setUint32(24, sampleRate, true);
  bytes.set(new Uint8Array(pcm), 28);
  return bytes.buffer;
}

function parseFrame(buffer) {
  const bytes = new Uint8Array(buffer);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'ASV1') throw new Error('bad media magic');
  const view = new DataView(buffer);
  return {
    version: bytes[4],
    kind: bytes[5],
    turn: Number(view.getBigUint64(8, true)),
    seq: Number(view.getBigUint64(16, true)),
    sampleRate: view.getUint32(24, true),
    pcm: bytes.subarray(28),
  };
}

function waitFor(socket, predicate, label, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    function onMessage(event) {
      const value = typeof event.data === 'string' ? JSON.parse(event.data) : parseFrame(event.data);
      if (!predicate(value)) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      resolve(value);
    }
    socket.addEventListener('message', onMessage);
  });
}

let socket;
try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/state`)).ok) break;
    } catch {}
    await sleep(100);
  }

  socket = new WebSocket(wsUrl);
  socket.binaryType = 'arraybuffer';
  await once(socket, 'open');
  socket.send(JSON.stringify({
    v: 1,
    type: 'hello',
    device_id: 'binary-media-smoke',
    caps: { speaker: true, display: 'smoke', media: ['pcm16-binary'] },
  }));

  await waitFor(socket, value => value.type === 'body.handoff', 'body handoff');
  socket.send(new Uint8Array([1, 2, 3]));
  const protocolError = await waitFor(
    socket,
    value => value.type === 'protocol.error' && value.code === 'invalid_binary_media',
    'binary protocol error',
  );

  socket.send(JSON.stringify({ v: 1, type: 'speech.start', at_ms: Date.now() }));
  const started = await waitFor(
    socket,
    value => value.type === 'turn.started',
    'turn.started',
  );
  const turn = Number(started.turn);
  for (let seq = 0; seq < 3; seq += 1) {
    socket.send(frame(1, turn, seq, 16000, new Int16Array(320).buffer));
  }
  socket.send(JSON.stringify({ v: 1, type: 'speech.end', turn, at_ms: Date.now() }));

  const audioPromise = waitFor(
    socket,
    value => value.kind === 2 && value.turn === turn,
    'binary say audio',
  );
  const say = await waitFor(
    socket,
    value => value.type === 'say' && value.turn === turn,
    'binary say metadata',
  );
  if (say.media !== 'pcm16-binary' || say.pcm_b64 !== '') {
    throw new Error(`unexpected say metadata: ${JSON.stringify(say)}`);
  }
  const audio = await audioPromise;
  if (audio.seq !== say.seq) throw new Error('binary audio seq does not match say metadata');

  console.log(JSON.stringify({
    ok: true,
    protocolError: protocolError.code,
    turn,
    binaryVersion: audio.version,
    binaryKind: audio.kind,
    text: say.text,
  }));
} finally {
  try { socket?.close(); } catch {}
  hub.kill();
  await Promise.race([once(hub, 'exit'), sleep(1000)]);
  try { fs.rmSync(tracePath, { force: true }); } catch {}
}

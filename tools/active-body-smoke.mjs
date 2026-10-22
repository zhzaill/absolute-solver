import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.SMOKE_PORT || 18199);
const baseUrl = `http://127.0.0.1:${port}`;
const wsUrl = `ws://127.0.0.1:${port}/ws`;
const hubBinary = process.env.HUB_BINARY || path.resolve('target/release/absolute-solver-hub.exe');
const tracePath = path.join(os.tmpdir(), `absolute-solver-active-body-${process.pid}.jsonl`);

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

let hubOutput = '';
hub.stdout.on('data', chunk => { hubOutput += String(chunk); });
hub.stderr.on('data', chunk => { hubOutput += String(chunk); });

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForHub() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/state`);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`hub did not start\n${hubOutput}`);
}

function waitForMessage(socket, predicate, label, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    function onMessage(event) {
      const message = JSON.parse(String(event.data));
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      resolve(message);
    }
    socket.addEventListener('message', onMessage);
  });
}

async function openBody(deviceId) {
  const socket = new WebSocket(wsUrl);
  await once(socket, 'open');
  socket.send(JSON.stringify({
    v: 1,
    type: 'hello',
    device_id: deviceId,
    caps: { mic: true, speaker: true, display: 'smoke' },
  }));
  return socket;
}

async function injectExpression(seq) {
  const response = await fetch(`${baseUrl}/cortico/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      type: 'persona.expression',
      session_id: 'active-body-smoke',
      seq,
      ts_mono_ms: Date.now(),
      source: 'active-body-smoke',
      payload: { text: `active-body-${seq}` },
    }),
  });
  if (response.status !== 202) {
    throw new Error(`inject failed: ${response.status} ${await response.text()}`);
  }
}

function expectNoMessage(socket, predicate, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      resolve();
    }, 600);
    function onMessage(event) {
      const message = JSON.parse(String(event.data));
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      reject(new Error(`unexpected ${label}: ${JSON.stringify(message)}`));
    }
    socket.addEventListener('message', onMessage);
  });
}

let bodyA;
let bodyB;
try {
  await waitForHub();
  bodyA = await openBody('active-body-a');
  const firstHandoff = await waitForMessage(
    bodyA,
    message => message.type === 'body.handoff',
    'first body handoff',
  );
  if (firstHandoff.active_body !== 'active-body-a') {
    throw new Error(`first active body mismatch: ${JSON.stringify(firstHandoff)}`);
  }
  if (firstHandoff.v !== 1) throw new Error('body.handoff must use protocol v1');

  bodyB = await openBody('active-body-b');
  const standbyHandoff = await waitForMessage(
    bodyB,
    message => message.type === 'body.handoff',
    'standby handoff',
  );
  if (standbyHandoff.active_body !== 'active-body-a') {
    throw new Error(`second body should remain standby: ${JSON.stringify(standbyHandoff)}`);
  }

  const firstSayOnA = waitForMessage(
    bodyA,
    message => message.type === 'say' && message.text === 'active-body-1',
    'say on active body',
  );
  const noSayOnB = expectNoMessage(
    bodyB,
    message => message.type === 'say' && message.text === 'active-body-1',
    'say on standby body',
  );
  await injectExpression(1);
  const firstSay = await firstSayOnA;
  if (firstSay.v !== 1) throw new Error('say must use protocol v1');
  await noSayOnB;

  const fallbackHandoff = waitForMessage(
    bodyB,
    message => message.type === 'body.handoff' && message.reason === 'active_body_disconnected',
    'fallback handoff',
  );
  bodyA.close();
  const fallback = await fallbackHandoff;
  if (fallback.active_body !== 'active-body-b') {
    throw new Error(`fallback active body mismatch: ${JSON.stringify(fallback)}`);
  }
  if (fallback.v !== 1) throw new Error('fallback handoff must use protocol v1');

  const secondSayOnB = waitForMessage(
    bodyB,
    message => message.type === 'say' && message.text === 'active-body-2',
    'say on fallback body',
  );
  await injectExpression(2);
  const secondSay = await secondSayOnB;
  if (secondSay.v !== 1) throw new Error('fallback say must use protocol v1');

  console.log(JSON.stringify({
    ok: true,
    firstActive: firstHandoff.active_body,
    standby: 'active-body-b',
    firstSayTurn: secondSay.turn - 1,
    fallbackActive: fallback.active_body,
    fallbackSayTurn: secondSay.turn,
  }));
} finally {
  try { bodyA?.close(); } catch {}
  try { bodyB?.close(); } catch {}
  hub.kill();
  await Promise.race([once(hub, 'exit'), sleep(1000)]);
  try { fs.rmSync(tracePath, { force: true }); } catch {}
}

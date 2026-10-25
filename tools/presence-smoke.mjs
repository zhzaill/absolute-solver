import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.SMOKE_PORT || 18196);
const baseUrl = `http://127.0.0.1:${port}`;
const wsUrl = `ws://127.0.0.1:${port}/ws`;
const token = 'presence-smoke-token';
const hostId = 'host-presence-smoke';
const hubBinary = process.env.HUB_BINARY || path.resolve('target/release/absolute-solver-hub.exe');
const tracePath = path.join(os.tmpdir(), `absolute-solver-presence-${process.pid}.jsonl`);

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
    SOLVER_ROBOTICS_WORLD_URL: '',
    SOLVER_PRESENCE_TOKEN: token,
    SOLVER_PRESENCE_HOSTS: hostId,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
hub.stdout.on('data', chunk => { output += String(chunk); });
hub.stderr.on('data', chunk => { output += String(chunk); });

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForHub() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/state`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`hub did not start\n${output}`);
}

function waitForMessage(socket, predicate, label, timeoutMs = 5000) {
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

async function post(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${pathname}: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

let socket;
try {
  await waitForHub();
  socket = new WebSocket(wsUrl);
  await once(socket, 'open');
  socket.send(JSON.stringify({
    v: 1,
    type: 'hello',
    device_id: hostId,
    caps: {
      display: 'host-overlay',
      host_presence: true,
      speaker: false,
      microphone: false,
      camera: false,
    },
  }));
  await waitForMessage(socket, message => message.type === 'body.handoff', 'body registration');

  const intentMessagePromise = waitForMessage(
    socket,
    message => message.type === 'presence.intent' && message.host_id === hostId,
    'presence.intent',
  );
  const intent = await post('/presence/intent', {
    host_id: hostId,
    reason: 'presence smoke test',
    urgency: 'high',
    requested_scopes: ['presence:notify', 'presence:show'],
    ttl_ms: 10_000,
  });
  const intentMessage = await intentMessagePromise;
  if (intentMessage.intent_id !== intent.intent_id) throw new Error('presence intent id mismatch');
  if (intentMessage.host_id !== hostId) throw new Error('presence intent routed to wrong host');

  socket.send(JSON.stringify({
    v: 1,
    type: 'presence.decision',
    intent_id: intent.intent_id,
    host_id: hostId,
    decision: 'appear',
  }));
  const grant = await waitForMessage(
    socket,
    message => message.type === 'presence.grant' && message.intent_id === intent.intent_id,
    'presence.grant',
  );
  if (grant.scope !== 'presence:show') throw new Error(`unexpected grant: ${JSON.stringify(grant)}`);

  await post('/presence/revoke', {
    host_id: hostId,
    intent_id: intent.intent_id,
    reason: 'smoke_complete',
  });
  const revoke = await waitForMessage(
    socket,
    message => message.type === 'presence.revoke' && message.intent_id === intent.intent_id,
    'presence.revoke',
  );

  console.log(JSON.stringify({
    ok: true,
    intentId: intent.intent_id,
    urgency: intentMessage.urgency,
    grantedScope: grant.scope,
    revokeReason: revoke.reason,
  }));
} finally {
  try { socket?.close(); } catch {}
  hub.kill();
  await Promise.race([once(hub, 'exit'), sleep(1000)]);
  try { fs.rmSync(tracePath, { force: true }); } catch {}
}

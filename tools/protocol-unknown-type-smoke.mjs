// Protocol v1 forward-compatibility smoke test.
//
// Registers a probe body, sends one message whose `type` the Hub does not know,
// then keeps using the same connection. Pass/fail:
//   - the Hub answers `protocol.error` with code `unknown_type` and fatal=false
//   - the connection stays open: a later `speech.start` is still answered by `turn.started`
//
// Usage: node tools/protocol-unknown-type-smoke.mjs [ws://127.0.0.1:18100/ws] [device-id]

const hubUrl = process.argv[2] || 'ws://127.0.0.1:18100/ws';
const deviceId = process.argv[3] || 'protocol-probe';
const socket = new WebSocket(hubUrl);

const inbox = [];
const waiters = [];

socket.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') return;
  let frame;
  try {
    frame = JSON.parse(event.data);
  } catch {
    return;
  }
  const waiter = waiters.shift();
  if (waiter) waiter(frame);
  else inbox.push(frame);
});

function nextFrame(timeoutMs = 2500) {
  if (inbox.length) return Promise.resolve(inbox.shift());
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = waiters.indexOf(resolve);
      if (index >= 0) waiters.splice(index, 1);
      resolve(null);
    }, timeoutMs);
    waiters.push((frame) => {
      clearTimeout(timer);
      resolve(frame);
    });
  });
}

function send(value) {
  socket.send(JSON.stringify(value));
}

function fail(message) {
  console.error(`FAIL ${message}`);
  try { socket.close(); } catch {}
  process.exit(1);
}

socket.addEventListener('error', () => fail(`websocket error at ${hubUrl}`));

socket.addEventListener('open', async () => {
  send({ v: 1, type: 'hello', device_id: deviceId, caps: { speaker: false } });
  await new Promise((resolve) => setTimeout(resolve, 300));

  send({ v: 1, type: 'body.telemetry', rpm: 12, payload: { x: 1 } });

  let protocolError = null;
  const seen = [];
  for (let index = 0; index < 4; index += 1) {
    const frame = await nextFrame();
    if (!frame) break;
    seen.push(frame.type);
    if (frame.type === 'protocol.error') {
      protocolError = frame;
      break;
    }
  }
  if (!protocolError) fail(`no protocol.error frame received (saw: ${seen.join(',') || 'none'})`);
  if (protocolError.code !== 'unknown_type') fail(`unexpected protocol.error code ${protocolError.code}`);
  if (protocolError.fatal !== false) fail('unknown_type must be non-fatal');

  send({ v: 1, type: 'speech.start', at_ms: 1 });
  let turnStarted = null;
  for (let index = 0; index < 4; index += 1) {
    const frame = await nextFrame();
    if (!frame) break;
    if (frame.type === 'turn.started') {
      turnStarted = frame;
      break;
    }
  }
  if (!turnStarted) fail('connection did not survive the unknown message type');

  console.log(
    `PASS hub=${hubUrl} device=${deviceId} code=${protocolError.code} fatal=${protocolError.fatal} ` +
      `message="${protocolError.message}" turn=${turnStarted.turn}`,
  );
  socket.close();
  process.exit(0);
});

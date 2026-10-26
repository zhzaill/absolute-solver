// Sends one `speech.start` as a body so the Hub allocates a new turn.
//
// Used by the TTS interrupt acceptance: while the active body is playing a
// segmented reply, a new turn must stop the buffered remainder on that body.
//
// Usage: node tools/body-interrupt.mjs [ws://127.0.0.1:18100/ws] [device-id]

const hubUrl = process.argv[2] || 'ws://127.0.0.1:18100/ws';
const deviceId = process.argv[3] || 'interrupt-probe';
const socket = new WebSocket(hubUrl);

socket.addEventListener('error', () => {
  console.error(`FAIL websocket error at ${hubUrl}`);
  process.exit(1);
});

socket.addEventListener('open', () => {
  socket.send(JSON.stringify({ v: 1, type: 'hello', device_id: deviceId, caps: { speaker: false } }));
  setTimeout(() => {
    socket.send(JSON.stringify({ v: 1, type: 'speech.start', at_ms: 1 }));
  }, 300);
});

socket.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') return;
  let frame;
  try {
    frame = JSON.parse(event.data);
  } catch {
    return;
  }
  if (frame.type === 'turn.started') {
    console.log(`PASS interrupt sent; hub allocated turn=${frame.turn}`);
    socket.close();
    process.exit(0);
  }
});

setTimeout(() => {
  console.error('FAIL no turn.started acknowledgement');
  process.exit(1);
}, 5000);

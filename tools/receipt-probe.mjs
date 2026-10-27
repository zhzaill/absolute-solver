// Sends exactly one `segment.receipt` and exits, to count how many the hub logs.
const url = process.argv[2] || 'ws://127.0.0.1:18200/ws';
const turn = Number(process.argv[3] || 6);
const seq = Number(process.argv[4] || 0);
const socket = new WebSocket(url);
socket.addEventListener('open', () => {
  socket.send(JSON.stringify({ v: 1, type: 'hello', device_id: 'receipt-probe', caps: { speaker: true } }));
  setTimeout(() => {
    socket.send(JSON.stringify({
      v: 1,
      type: 'segment.receipt',
      turn,
      seq,
      outcome: 'played',
      reason: 'played',
      pcm_ms: 100,
    }));
    setTimeout(() => { socket.close(); process.exit(0); }, 800);
  }, 300);
});
socket.addEventListener('error', () => process.exit(1));

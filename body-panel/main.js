const params = new URLSearchParams(location.search);
const hubUrl = params.get('hub') || 'ws://127.0.0.1:18100/ws';
const hostTicket = params.get('session');
const deviceId = `host-panel-${Math.random().toString(16).slice(2, 8)}`;
const stateEl = document.getElementById('state');
const stateText = document.getElementById('stateText');
const endpoint = document.getElementById('endpoint');
const detail = document.getElementById('detail');
const subtitle = document.getElementById('subtitle');
const soundButton = document.getElementById('sound');

let socket = null;
let retryTimer = null;
let audioContext = null;
let latestPcm = null;
let latestRate = 16000;

endpoint.textContent = hubUrl;

function setState(connected, text, note) {
  stateEl.classList.toggle('off', !connected);
  stateText.textContent = text;
  if (note) detail.textContent = note;
}

function decodeBase64(value) {
  const binary = atob(value || '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function playPcm(pcm, sampleRate) {
  latestPcm = pcm;
  latestRate = sampleRate;
  if (!audioContext || audioContext.state !== 'running' || pcm.length === 0) return;
  const samples = new Float32Array(pcm.byteLength / 2);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768;
  }
  const buffer = audioContext.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.start();
}

function receive(message) {
  if (message.type === 'say') {
    subtitle.textContent = message.text || '';
    subtitle.classList.toggle('on', Boolean(message.text));
    playPcm(decodeBase64(message.pcm_b64), Number(message.sr) || 16000);
    detail.textContent = `回合 ${message.turn} · ${(message.mouth || []).length} 个口型值`;
  }
  if (message.type === 'render.cue' && message.text) {
    subtitle.textContent = message.text;
    subtitle.classList.add('on');
    detail.textContent = `演出事件 · ${message.kind}`;
  }
  if (message.type === 'body.handoff') {
    const active = message.active_body === deviceId;
    document.body.classList.toggle('standby', !active);
    setState(
      true,
      active ? '此电脑已连接' : '此电脑待机',
      active ? `当前活动身体 · ${message.reason || 'active'}` : '当前由其他 Body 负责输出',
    );
  }
}

function connect() {
  clearTimeout(retryTimer);
  try { socket?.close(); } catch {}
  setState(false, '正在连接', '正在建立受信任局域网连接');
  socket = new WebSocket(hubUrl);
  socket.addEventListener('open', () => {
    setState(true, '已连接 Hub', '正在注册本机 Body');
    const caps = { speaker: true, display: 'host-panel', subtitle: true };
    if (hostTicket) caps.host_ticket = hostTicket;
    socket.send(JSON.stringify({
      v: 1,
      type: 'hello',
      device_id: deviceId,
      caps,
    }));
  });
  socket.addEventListener('message', event => {
    try { receive(JSON.parse(String(event.data))); } catch {}
  });
  socket.addEventListener('close', () => {
    setState(false, '连接已断开', '3 秒后自动重连');
    retryTimer = setTimeout(connect, 3000);
  });
  socket.addEventListener('error', () => setState(false, '连接失败', '检查 Hub 地址或局域网'));
}

soundButton.addEventListener('click', async () => {
  audioContext ||= new AudioContext();
  await audioContext.resume();
  soundButton.textContent = '声音已启用';
  soundButton.setAttribute('aria-pressed', 'true');
  if (latestPcm) playPcm(latestPcm, latestRate);
});

connect();

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
const micButton = document.getElementById('mic');

const BINARY_HEADER_LEN = 28;
const BINARY_VERSION = 1;
const BINARY_AUDIO_UP = 1;
const BINARY_SAY_AUDIO = 2;
const VAD_THRESHOLD = 0.018;
const VAD_START_FRAMES = 3;
const VAD_END_FRAMES = 28;
const PRE_ROLL_FRAMES = 15;

let socket = null;
let retryTimer = null;
let audioContext = null;
let latestPcm = null;
let latestRate = 16000;
let pendingSay = null;
let playbackUntil = 0;

const mic = {
  running: false,
  context: null,
  stream: null,
  source: null,
  node: null,
  speaking: false,
  awaitingTurn: false,
  endRequested: false,
  turn: 0,
  seq: 0,
  sampleRate: 16000,
  voiced: 0,
  silent: 0,
  preRoll: [],
  pending: [],
};

endpoint.textContent = hubUrl;

function setState(connected, text, note) {
  stateEl.classList.toggle('off', !connected);
  stateText.textContent = text;
  if (note) detail.textContent = note;
}

function sendJson(value) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ v: 1, ...value }));
  return true;
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
  playbackUntil = Date.now() + (samples.length / sampleRate) * 1000 + 120;
}

function encodeBinaryFrame(kind, turn, seq, sampleRate, pcm) {
  const bytes = new Uint8Array(BINARY_HEADER_LEN + pcm.byteLength);
  bytes.set([0x41, 0x53, 0x56, 0x31], 0);
  bytes[4] = BINARY_VERSION;
  bytes[5] = kind;
  const view = new DataView(bytes.buffer);
  view.setBigUint64(8, BigInt(turn), true);
  view.setBigUint64(16, BigInt(seq), true);
  view.setUint32(24, sampleRate, true);
  bytes.set(new Uint8Array(pcm), BINARY_HEADER_LEN);
  return bytes.buffer;
}

function sendMicAudio(pcm) {
  if (socket?.readyState !== WebSocket.OPEN || !mic.turn) return;
  socket.send(encodeBinaryFrame(BINARY_AUDIO_UP, mic.turn, mic.seq++, mic.sampleRate, pcm));
}

function emitMicAudio(pcm) {
  if (mic.awaitingTurn) mic.pending.push(pcm);
  else sendMicAudio(pcm);
}

function finishSpeech() {
  if (!mic.speaking || !mic.turn) return;
  sendJson({ type: 'speech.end', turn: mic.turn, at_ms: Date.now() });
  mic.speaking = false;
  mic.awaitingTurn = false;
  mic.endRequested = false;
  mic.voiced = 0;
  mic.silent = 0;
  mic.preRoll = [];
  mic.pending = [];
  detail.textContent = '语音已发送，等待求解器';
}

function beginSpeech() {
  mic.speaking = true;
  mic.awaitingTurn = true;
  mic.endRequested = false;
  mic.turn = 0;
  mic.seq = 0;
  mic.silent = 0;
  mic.pending = mic.preRoll.slice();
  mic.preRoll = [];
  detail.textContent = '检测到语音，等待 Hub 分配回合';
  sendJson({ type: 'speech.start', at_ms: Date.now() });
}

function receiveMicFrame({ pcm, rms, sampleRate }) {
  if (!mic.running) return;
  mic.sampleRate = Number(sampleRate) || mic.sampleRate;
  if (!mic.speaking && Date.now() < playbackUntil) return;
  const voiced = Number(rms) >= VAD_THRESHOLD;
  if (!mic.speaking) {
    mic.preRoll.push(pcm);
    while (mic.preRoll.length > PRE_ROLL_FRAMES) mic.preRoll.shift();
    mic.voiced = voiced ? mic.voiced + 1 : 0;
    if (mic.voiced >= VAD_START_FRAMES) beginSpeech();
    return;
  }
  if (mic.endRequested) return;
  emitMicAudio(pcm);
  if (voiced) {
    mic.silent = 0;
  } else {
    mic.silent += 1;
    if (mic.silent >= VAD_END_FRAMES) {
      mic.endRequested = true;
      if (!mic.awaitingTurn) finishSpeech();
    }
  }
}

function receiveSay(message) {
  subtitle.textContent = message.text || '';
  subtitle.classList.toggle('on', Boolean(message.text));
  detail.textContent = `回合 ${message.turn} · ${(message.mouth || []).length} 个口型值`;
  if (message.media === 'pcm16-binary') {
    pendingSay = {
      turn: Number(message.turn) || 0,
      seq: Number(message.seq) || 0,
      sampleRate: Number(message.sr) || 16000,
    };
    detail.textContent += ' · 等待二进制音频';
    return;
  }
  playPcm(decodeBase64(message.pcm_b64), Number(message.sr) || 16000);
}

function receiveBinary(buffer) {
  if (buffer.byteLength < BINARY_HEADER_LEN) return;
  const bytes = new Uint8Array(buffer);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'ASV1' || bytes[4] !== BINARY_VERSION) return;
  if (bytes[5] !== BINARY_SAY_AUDIO) return;
  const view = new DataView(buffer);
  const turn = Number(view.getBigUint64(8, true));
  const seq = Number(view.getBigUint64(16, true));
  const sampleRate = view.getUint32(24, true);
  if (!pendingSay || pendingSay.turn !== turn || pendingSay.seq !== seq) return;
  const pcm = bytes.subarray(BINARY_HEADER_LEN);
  pendingSay = null;
  playPcm(pcm, sampleRate || 16000);
}

function receive(message) {
  if (message.type === 'say') receiveSay(message);
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
  if (message.type === 'turn.started') {
    mic.turn = Number(message.turn) || 0;
    mic.awaitingTurn = false;
    for (const pcm of mic.pending.splice(0)) sendMicAudio(pcm);
    if (mic.endRequested) finishSpeech();
    detail.textContent = `回合 ${mic.turn} · 正在传输语音`;
  }
  if (message.type === 'protocol.error') {
    detail.textContent = `协议错误 ${message.code}: ${message.message}`;
  }
}

function connect() {
  clearTimeout(retryTimer);
  try { socket?.close(); } catch {}
  setState(false, '正在连接', '正在建立受信任局域网连接');
  socket = new WebSocket(hubUrl);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    setState(true, '已连接 Hub', '正在注册本机 Body');
    const caps = {
      speaker: true,
      display: 'host-panel',
      subtitle: true,
      microphone: true,
      media: ['pcm16-binary'],
    };
    if (hostTicket) caps.host_ticket = hostTicket;
    sendJson({ type: 'hello', device_id: deviceId, caps });
  });
  socket.addEventListener('message', event => {
    if (event.data instanceof ArrayBuffer) {
      receiveBinary(event.data);
      return;
    }
    try { receive(JSON.parse(String(event.data))); } catch {}
  });
  socket.addEventListener('close', () => {
    setState(false, '连接已断开', '3 秒后自动重连');
    mic.speaking = false;
    mic.awaitingTurn = false;
    retryTimer = setTimeout(connect, 3000);
  });
  socket.addEventListener('error', () => setState(false, '连接失败', '检查 Hub 地址或局域网'));
}

async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    throw new Error('浏览器不支持 AudioWorklet 麦克风采集');
  }
  const context = new AudioContext({ sampleRate: 16000 });
  await context.audioWorklet.addModule('/mic-worklet.js');
  await context.resume();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'solver-capture');
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute).connect(context.destination);
  node.port.onmessage = event => receiveMicFrame(event.data);
  mic.context = context;
  mic.stream = stream;
  mic.source = source;
  mic.node = node;
  mic.running = true;
  micButton.textContent = '麦克风已启用';
  micButton.setAttribute('aria-pressed', 'true');
  detail.textContent = '麦克风已启用 · 检测到说话会自动发送';
}

async function stopMic() {
  if (mic.speaking) finishSpeech();
  mic.running = false;
  mic.speaking = false;
  mic.awaitingTurn = false;
  mic.preRoll = [];
  mic.pending = [];
  try { mic.node?.disconnect(); } catch {}
  try { mic.source?.disconnect(); } catch {}
  for (const track of mic.stream?.getTracks() || []) track.stop();
  try { await mic.context?.close(); } catch {}
  mic.context = null;
  mic.stream = null;
  mic.source = null;
  mic.node = null;
  micButton.textContent = '启用麦克风';
  micButton.setAttribute('aria-pressed', 'false');
  detail.textContent = '麦克风已关闭';
}

micButton.addEventListener('click', async () => {
  try {
    if (mic.running) await stopMic();
    else await startMic();
  } catch (error) {
    detail.textContent = `麦克风不可用: ${error instanceof Error ? error.message : String(error)}`;
  }
});

soundButton.addEventListener('click', async () => {
  audioContext ||= new AudioContext();
  await audioContext.resume();
  soundButton.textContent = '声音已启用';
  soundButton.setAttribute('aria-pressed', 'true');
  if (latestPcm) playPcm(latestPcm, latestRate);
});

connect();

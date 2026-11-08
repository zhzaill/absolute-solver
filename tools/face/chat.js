// First projection: the conversation only. No settings, no model picker, no
// import — those live on the host. TTS audio is played by the figure window.
import { createFaceClient } from './face-client.js';
import { escapeHtml, formatTime } from './face-util.js';

const $ = (id) => document.getElementById(id);
const els = {
  messages: $('messages'),
  composer: $('composer'),
  input: $('input'),
  mic: $('mic'),
  conn: $('conn'),
  hint: $('hint'),
  pulse: $('pulse'),
};

const client = createFaceClient({
  onReady: (ready) => setConn(ready),
  onMessage: (data) => {
    addMessage(data.role, data.text, { mood: data.mood, ts: data.ts });
    if (data.role === 'assistant') els.pulse.classList.add('live');
  },
  onError: (data) => {
    if (data.code === 'tts') setHint(`语音合成失败：${data.message || ''}`);
  },
  onTranscript: (data) => {
    if (data.failed) setHint(`没听清：${data.text || data.message || '转写失败'}`);
  },
});

const recorder = client.createRecorder({
  onState: (state) => {
    if (state === 'recording') { els.mic.setAttribute('aria-pressed', 'true'); setHint('正在录音…再点一次结束'); }
    else if (state === 'transcribing') { els.mic.setAttribute('aria-pressed', 'false'); setHint('正在转写…'); }
    else if (state === 'error') { els.mic.setAttribute('aria-pressed', 'false'); }
    else { els.mic.setAttribute('aria-pressed', 'false'); }
  },
});

function setConn(ready) {
  els.conn.dataset.state = ready ? 'online' : 'connecting';
  els.conn.textContent = ready ? '在线' : '重连中';
}

function setHint(text) { els.hint.textContent = text; }

function addMessage(role, text, { mood = null, ts = null, system = false } = {}) {
  const node = document.createElement('div');
  node.className = `msg ${system ? 'system' : role}`;
  node.innerHTML = `${escapeHtml(text)}${ts ? `<span class="meta">${escapeHtml(formatTime(ts))}${mood ? ` · ${escapeHtml(mood)}` : ''}</span>` : ''}`;
  els.messages.appendChild(node);
  els.messages.scrollTop = els.messages.scrollHeight;
  while (els.messages.childElementCount > 400) els.messages.firstElementChild.remove();
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(140, els.input.scrollHeight)}px`;
}

async function send(text) {
  const value = String(text || '').trim();
  if (!value) return;
  addMessage('user', value);
  els.input.value = '';
  autosize();
  const result = await client.say(value);
  if (!result.ok) addMessage('system', `发送失败：${result.error}`, { system: true });
}

els.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  send(els.input.value);
});
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});

els.mic.addEventListener('click', async () => {
  if (!asrReady && !recorder.recording) {
    await probeMic();
    return;
  }
  try {
    if (recorder.recording) {
      const text = await recorder.stop();
      if (text && typeof text === 'object' && text.error) {
        setHint(`转写失败：${text.error}`);
        addMessage('system', `语音输入失败：${text.error}`, { system: true });
        return;
      }
      if (text) { setHint('已转写'); await send(text); }
      return;
    }
    await recorder.start();
  } catch (error) {
    setHint(`麦克风不可用：${error.message}`);
  }
});

let asrReady = true;

if (!window.isSecureContext) {
  els.mic.disabled = true;
  setHint('语音输入需要 HTTPS 或 localhost');
}

// Ask the browser for the microphone even when the host ASR is not up yet, so
// the permission prompt can appear and the block is visible in the hint line.
async function probeMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    setHint('麦克风已授权 · 主机 ASR 未就绪，暂时无法转写');
  } catch (error) {
    setHint(error?.name === 'NotAllowedError'
      ? '浏览器未允许麦克风：请在地址栏的站点设置里允许后重试'
      : `麦克风不可用：${error.message}`);
  }
}

(async () => {
  try {
    const response = await fetch('/face/status', { cache: 'no-store' });
    const data = await response.json();
    if (data.asr !== 'online') {
      asrReady = false;
      setHint('主机 ASR 未就绪 · 点麦克风可先授予浏览器权限');
    }
  } catch { /* ignore */ }
  try {
    const state = await navigator.permissions?.query({ name: 'microphone' });
    if (state?.state === 'denied') setHint('浏览器已拒绝麦克风：请在地址栏的站点设置里允许后重试');
    state?.addEventListener?.('change', () => {
      if (state.state === 'denied') setHint('浏览器已拒绝麦克风：请在地址栏的站点设置里允许后重试');
    });
  } catch { /* permission API unsupported */ }
  client.connect();
})();

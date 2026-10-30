const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
const state = { config: null, socket: null, retry: null, active: null, ttl: null, access: new Map() };
const showScope = 'presence:show';

function status(text, kind = '') {
  $('connection').textContent = text;
  $('connection').className = `state ${kind}`;
}

function send(value) {
  if (state.socket?.readyState !== WebSocket.OPEN) return false;
  state.socket.send(JSON.stringify({ v: 1, ...value }));
  return true;
}

function setOverlay(active, reason = '') {
  $('settings-view').hidden = active;
  $('overlay-view').hidden = !active;
  if (active) {
    $('overlay-reason').textContent = reason;
    initMatrixEffect();
  } else {
    stopMatrixEffect();
  }
}

function renderAccessRequests() {
  const root = $('access-requests');
  root.replaceChildren();
  if (!state.access.size) { root.textContent = '当前没有待确认请求'; root.className = 'access-empty'; return; }
  root.className = '';
  for (const request of state.access.values()) {
    const card = document.createElement('article');
    card.className = 'access-request';
    const title = document.createElement('b');
    title.textContent = `${request.source_instance} 请求访问 ${request.target_service === 'tts' ? 'TTS' : 'ASR'}`;
    const detail = document.createElement('p');
    detail.textContent = `操作：${request.operation} · 原因：${request.purpose} · 剩余 ${Math.max(0, Math.ceil((Number(request.expires_at_ms) - Date.now()) / 1000))} 秒`;
    const actions = document.createElement('div');
    actions.className = 'access-actions';
    for (const [label, allow] of [['允许一次', true], ['拒绝', false]]) {
      const button = document.createElement('button');
      button.textContent = label;
      if (!allow) button.className = 'deny';
      button.addEventListener('click', () => {
        if (!send({ type: 'access.decision', request_id: request.request_id, host_id: state.config.hostId, allow })) return;
        state.access.delete(request.request_id);
        renderAccessRequests();
        $('activity-title').textContent = allow ? '已允许一次服务访问' : '已拒绝服务访问';
        $('activity-detail').textContent = `${request.source_instance} · ${request.target_service} · ${request.operation}`;
      });
      actions.appendChild(button);
    }
    card.append(title, detail, actions);
    root.appendChild(card);
  }
}

async function hide(intentId, sendRevoke = true, reason = 'user_revoked') {
  if (!state.active || state.active.intentId !== intentId) return;
  const detail = `reason=${reason}; ws=${state.socket?.readyState ?? 'none'}; visibility=${document.visibilityState}; focus=${document.hasFocus()}; active=${document.activeElement?.id || 'none'}`;
  invoke('record_host_event', { event: 'presence.hide', intentId, detail }).catch(() => {});
  if (sendRevoke) {
    send({ type: 'presence.revoke', intent_id: intentId, host_id: state.config.hostId, reason });
  }
  clearTimeout(state.ttl);
  state.active = null;
  try { await invoke('hide_presence_overlay', { intentId }); } catch (error) { console.error(error); }
  setOverlay(false);
  $('activity-title').textContent = '到访已结束';
  $('activity-detail').textContent = reason === 'ttl_expired' ? '连接租约已到期' : '覆盖层已隐藏，本机访问已撤销';
}

async function receiveIntent(message) {
  if (message.host_id !== state.config.hostId) return;
  if (Number(message.expires_at_ms) <= Date.now()) {
    send({ type: 'presence.decision', intent_id: message.intent_id, host_id: state.config.hostId, decision: 'reject' });
    return;
  }
  const scopes = Array.isArray(message.requested_scopes) ? message.requested_scopes : [];
  if (state.config.policy === 'reject') {
    send({ type: 'presence.decision', intent_id: message.intent_id, host_id: state.config.hostId, decision: 'reject' });
    $('activity-title').textContent = '已拒绝到访请求';
    $('activity-detail').textContent = '本机策略拒绝了此请求';
    return;
  }
  if (state.config.policy === 'appear' && scopes.includes(showScope)) {
    state.active = { intentId: message.intent_id, reason: String(message.reason || '') };
    $('activity-title').textContent = '正在请求限时显示';
    $('activity-detail').textContent = state.active.reason;
    send({ type: 'presence.decision', intent_id: message.intent_id, host_id: state.config.hostId, decision: 'appear' });
    return;
  }
  try { await invoke('notify_presence', { reason: String(message.reason || 'Hub 请求连接') }); }
  catch (error) { $('activity-detail').textContent = `系统通知失败：${error}`; }
  $('activity-title').textContent = '收到连接请求';
  $('activity-detail').textContent = String(message.reason || 'Hub 请求连接');
  send({ type: 'presence.decision', intent_id: message.intent_id, host_id: state.config.hostId, decision: 'notify' });
}

async function receiveGrant(message) {
  if (message.host_id !== state.config.hostId || message.scope !== showScope) return;
  if (!state.active || state.active.intentId !== message.intent_id || state.config.policy !== 'appear') return;
  const expiresAt = Number(message.expires_at_ms);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return hide(message.intent_id, true, 'ttl_expired');
  try {
    await invoke('show_presence_overlay', {
      intentId: message.intent_id,
      hostId: message.host_id,
      scope: message.scope,
      expiresAtMs: expiresAt,
    });
    state.active.expiresAtMs = expiresAt;
    state.active.startedAt = Date.now();
    setOverlay(true, state.active.reason);
    $('activity-title').textContent = '限时到访中';
    $('activity-detail').textContent = '覆盖层已显示，可立即撤销';
    updateTTLBar(expiresAt);
    clearTimeout(state.ttl);
    state.ttl = setTimeout(() => hide(message.intent_id, true, 'ttl_expired'), expiresAt - Date.now());
    // Update TTL bar every second
    const ttlUpdater = setInterval(() => {
      if (!state.active || state.active.intentId !== message.intent_id) {
        clearInterval(ttlUpdater);
        return;
      }
      updateTTLBar(expiresAt);
    }, 1000);
    // Demo subtitle after 1 second
    setTimeout(() => {
      if (state.active?.intentId === message.intent_id) {
        showSubtitle('正在建立安全连接...\n所有操作均在本地权限租约范围内进行');
      }
    }, 1000);
  } catch (error) {
    console.error(error);
    await hide(message.intent_id, true, 'local_policy_denied');
  }
}

async function receiveRevoke(message) {
  if (message.host_id === state.config.hostId && state.active?.intentId === message.intent_id) {
    await hide(message.intent_id, false, message.reason || 'hub_revoked');
  }
}

function connect() {
  clearTimeout(state.retry);
  try { state.socket?.close(); } catch {}
  status('正在连接');
  const socket = new WebSocket(state.config.hubWsUrl);
  state.socket = socket;
  socket.addEventListener('open', () => {
    status('Hub 已连接', 'ok');
    socket.send(JSON.stringify({
      v: 1,
      type: 'hello',
      device_id: state.config.hostId,
      caps: { host_presence: true, host_access: true, display: 'host-overlay', speaker: false, microphone: false, camera: false },
    }));
  });
  socket.addEventListener('message', async (event) => {
    if (typeof event.data !== 'string') return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'presence.intent') await receiveIntent(message);
      if (message.type === 'presence.grant') await receiveGrant(message);
      if (message.type === 'presence.revoke') await receiveRevoke(message);
      if (message.type === 'access.request' && message.target_host_id === state.config.hostId && Number(message.expires_at_ms) > Date.now()) {
        state.access.set(message.request_id, message);
        renderAccessRequests();
        $('activity-title').textContent = '需要确认一次服务访问';
        $('activity-detail').textContent = `${message.source_instance} · ${message.target_service} · ${message.operation}`;
        invoke('record_host_event', { event: 'access.request.prompt', intentId: message.request_id, detail: `${message.source_instance} · ${message.target_service} · ${message.operation}` }).catch(() => {});
        invoke('show_host_window').catch((error) => console.error('Cannot show access request window', error));
      }
      if (message.type === 'access.result') { state.access.delete(message.request_id); renderAccessRequests(); }
    } catch (error) { console.error('Hub frame failed', error); }
  });
  socket.addEventListener('close', () => {
    status('Hub 已断开', 'bad');
    state.retry = setTimeout(connect, 3000);
  });
  socket.addEventListener('error', () => status('连接失败', 'bad'));
}

async function load() {
  state.config = await invoke('get_host_config');
  $('hub-url').value = state.config.hubWsUrl;
  $('host-id').value = state.config.hostId;
  $('policy').value = state.config.policy;
  $('activity-detail').textContent = `本机策略：${state.config.policy} · 主机 ${state.config.hostId}`;
  connect();
}

$('save').addEventListener('click', async () => {
  try {
    state.config = await invoke('save_host_config', { hubWsUrl: $('hub-url').value.trim(), policy: $('policy').value });
    $('host-id').value = state.config.hostId;
    $('activity-detail').textContent = `设置已保存 · 本机策略 ${state.config.policy}`;
    connect();
  } catch (error) { $('activity-detail').textContent = `保存失败：${error}`; }
});

$('revoke').addEventListener('click', (event) => {
  if (!state.active) return;
  const detail = `source=button; trusted=${event.isTrusted}; x=${event.clientX}; y=${event.clientY}`;
  invoke('record_host_event', { event: 'presence.revoke-input', intentId: state.active.intentId, detail }).catch(() => {});
  hide(state.active.intentId, true);
});
listen('host:revoke-request', () => {
  if (!state.active) return;
  invoke('record_host_event', { event: 'presence.revoke-input', intentId: state.active.intentId, detail: 'source=tray' }).catch(() => {});
  hide(state.active.intentId, true, 'tray_revoked');
});
load().catch((error) => status(`启动失败：${error}`, 'bad'));

// Matrix rain effect
let matrixInterval = null;
const matrixChars = '01アイウエオカキクセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function initMatrixEffect() {
  stopMatrixEffect();
  const container = $('matrix-bg');
  container.innerHTML = '';
  const columnCount = Math.floor(window.innerWidth / 20);
  for (let i = 0; i < columnCount; i++) {
    const column = document.createElement('div');
    column.className = 'matrix-col';
    column.style.left = `${i * 20}px`;
    column.style.animationDuration = `${8 + Math.random() * 8}s`;
    column.style.animationDelay = `${Math.random() * 5}s`;
    const length = 10 + Math.floor(Math.random() * 15);
    let text = '';
    for (let j = 0; j < length; j++) {
      text += matrixChars[Math.floor(Math.random() * matrixChars.length)] + '\n';
    }
    column.textContent = text;
    container.appendChild(column);
  }
  matrixInterval = setInterval(() => {
    document.querySelectorAll('.matrix-col').forEach(col => {
      const length = 10 + Math.floor(Math.random() * 15);
      let text = '';
      for (let j = 0; j < length; j++) {
        text += matrixChars[Math.floor(Math.random() * matrixChars.length)] + '\n';
      }
      col.textContent = text;
    });
  }, 3000);
}

function stopMatrixEffect() {
  if (matrixInterval) {
    clearInterval(matrixInterval);
    matrixInterval = null;
  }
}

// TTL progress bar updater
function updateTTLBar(expiresAtMs) {
  const now = Date.now();
  const total = expiresAtMs - (state.active?.startedAt || now);
  const remaining = expiresAtMs - now;
  const percentage = Math.max(0, Math.min(100, (remaining / total) * 100));
  const fill = $('ttl-fill');
  if (fill) fill.style.width = `${percentage}%`;
  if (remaining > 0) {
    const seconds = Math.ceil(remaining / 1000);
    $('overlay-ttl-text').textContent = `租约剩余 ${seconds} 秒`;
  } else {
    $('overlay-ttl-text').textContent = '租约已过期';
  }
}

// Subtitle typewriter effect
function showSubtitle(text, duration = 5000) {
  const area = $('subtitle-area');
  const textEl = $('subtitle-text');
  area.style.display = 'block';
  textEl.textContent = '';
  let index = 0;
  const speed = Math.max(30, Math.min(80, duration / text.length));
  const typeInterval = setInterval(() => {
    if (index < text.length) {
      textEl.textContent += text[index];
      index++;
    } else {
      clearInterval(typeInterval);
      setTimeout(() => {
        area.style.display = 'none';
      }, 2000);
    }
  }, speed);
}

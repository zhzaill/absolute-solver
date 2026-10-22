const corticoUrl = process.env.CORTICO_URL || 'http://127.0.0.1:7777';
const ticketTimeoutMs = Number(process.env.HOST_TICKET_TIMEOUT_MS || 12000);
const holdMs = Number(process.env.HOLD_MS || 0);
const deviceId = `host-panel-smoke-${Math.random().toString(16).slice(2, 10)}`;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function redirectLocation(response, label) {
  const location = response.headers.get('location');
  if (!location) throw new Error(`${label} did not return a redirect: ${response.status}`);
  return location;
}

function waitForActiveHandoff(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('timed out waiting for active body handoff'));
    }, timeoutMs);
    function onMessage(event) {
      const message = JSON.parse(String(event.data));
      if (message.type !== 'body.handoff' || message.active_body !== deviceId) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      resolve(message);
    }
    socket.addEventListener('message', onMessage);
  });
}

const corticoResponse = await fetch(`${corticoUrl}/api/host-connect`, { redirect: 'manual' });
if (corticoResponse.status !== 302) {
  throw new Error(`Cortico host-connect expected 302, got ${corticoResponse.status}`);
}
const hubConnectUrl = redirectLocation(corticoResponse, 'Cortico host-connect');

const hubResponse = await fetch(hubConnectUrl, { redirect: 'manual' });
if (hubResponse.status !== 307) {
  throw new Error(`Hub host-connect expected 307, got ${hubResponse.status}`);
}
const panelLocation = redirectLocation(hubResponse, 'Hub host-connect');
const panelUrl = new URL(panelLocation);
const ticket = panelUrl.searchParams.get('session');
const wsUrl = panelUrl.searchParams.get('hub');
if (!ticket || !wsUrl) {
  throw new Error(`invalid panel redirect: ${panelLocation}`);
}

const socket = new WebSocket(wsUrl);
try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('host panel websocket failed')), { once: true });
  });
  const activeHandoff = waitForActiveHandoff(socket, ticketTimeoutMs);
  socket.send(JSON.stringify({
    v: 1,
    type: 'hello',
    device_id: deviceId,
    caps: {
      speaker: true,
      display: 'host-panel',
      subtitle: true,
      host_ticket: ticket,
    },
  }));
  const handoff = await activeHandoff;
  if (handoff.v !== 1) throw new Error('host handoff must use protocol v1');

  const hubBase = wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
  let monitor;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    monitor = await (await fetch(`${hubBase}/monitor.json`)).json();
    if (monitor.active_body === deviceId && monitor.devices?.[deviceId]?.caps?.entry === 'cortico') break;
    await sleep(100);
  }
  const device = monitor?.devices?.[deviceId];
  if (monitor?.active_body !== deviceId) {
    throw new Error(`active body was not registered: ${JSON.stringify(monitor?.active_body)}`);
  }
  if (device?.caps?.entry !== 'cortico') {
    throw new Error(`host panel entry was not cortico: ${JSON.stringify(device?.caps)}`);
  }
  if (Object.hasOwn(device.caps, 'host_ticket')) {
    throw new Error('host ticket leaked into monitor capabilities');
  }

  console.log(JSON.stringify({
    ok: true,
    corticoRedirect: hubConnectUrl,
    panelHost: panelUrl.host,
    deviceId,
    entry: device.caps.entry,
    activeBody: monitor.active_body,
  }));
  if (holdMs > 0) await sleep(holdMs);
} finally {
  socket.close();
}

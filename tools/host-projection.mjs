import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, resolve, sep } from 'node:path';
import { buildCatalog, rewriteCooCsp } from './host-projection-lib.mjs';
import { createFaceBridge } from './face-bridge.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const localConfigPath = `${root}/host-projection.local.json`;
const configPath = resolve(process.env.SOLVER_PROJECTION_CONFIG || (existsSync(localConfigPath) ? localConfigPath : `${root}/host-projection.example.json`));
const config = JSON.parse(await readFile(configPath, 'utf8'));

const host = process.env.SOLVER_PROJECTION_HOST || config.listenHost || '0.0.0.0';
const httpPort = Number(process.env.SOLVER_PROJECTION_PORT || config.listenPort || 18111);
const httpsPort = Number(process.env.SOLVER_PROJECTION_TLS_PORT || config.tls?.port || 18112);
// HTTPS is the primary surface; plain HTTP only redirects to it.
const httpsPrimary = config.tls?.enabled !== false && process.env.SOLVER_PROJECTION_HTTPS !== '0';

const tlsCertPath = process.env.SOLVER_PROJECTION_TLS_CERT || config.tls?.cert || `${root}/certs/projection-cert.pem`;
const tlsKeyPath = process.env.SOLVER_PROJECTION_TLS_KEY || config.tls?.key || `${root}/certs/projection-key.pem`;

// LAN direct + Tailscale: the same server is reachable on the LAN address and
// on the Tailscale address. For the tailnet we broadcast with `tailscale serve`
// (trusted *.ts.net cert) instead of hand-managing certificates.
function detectTailscale() {
  if (config.network?.tailscale?.enabled === false) return null;
  try {
    const raw = execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const status = JSON.parse(raw);
    const dnsName = String(status.Self?.DNSName || '').replace(/\.$/, '');
    const ipv4 = (status.Self?.TailscaleIPs || []).find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) || null;
    if (!dnsName && !ipv4) return null;
    return { dnsName, ipv4, magicDnsSuffix: status.MagicDNSSuffix || null, backendState: status.BackendState || null };
  } catch {
    return null;
  }
}
const tailscale = detectTailscale();

function isLoopbackAddress(address) {
  return !address || address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

// ---------------------------------------------------------------------------
// SSH: the only way this projection reaches a remote device's local services.
// Each service port is forwarded with `ssh -L` and upstreams point at the
// loopback end of the tunnel. No device is configured => local services.
// ---------------------------------------------------------------------------
const DEFAULT_TUNNELS = {
  coo: { remotePort: 7797, localPort: 27797 },
  cortico: { remotePort: 17788, localPort: 27788 },
  asr: { remotePort: 9881, localPort: 29881 },
  tts: { remotePort: 18080, localPort: 28080 },
  llm: { remotePort: 18081, localPort: 28081 },
};

const device = config.device || {};
const deviceEnabled = device.enabled === true || (device.enabled === undefined && Boolean(device.host && device.user));
const tunnelSpecs = Object.entries(DEFAULT_TUNNELS).map(([name, def]) => ({ name, ...def, ...(device.tunnels?.[name] || {}) }));
const tunnelState = new Map();
let shuttingDown = false;

function startTunnel(spec) {
  const args = [
    '-N', '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', `StrictHostKeyChecking=${device.strictHostKeyChecking || 'yes'}`,
  ];
  if (device.knownHostsFile) args.push('-o', `UserKnownHostsFile=${device.knownHostsFile}`);
  if (device.identityFile) args.push('-i', device.identityFile);
  args.push('-L', `127.0.0.1:${spec.localPort}:${device.remoteHost || '127.0.0.1'}:${spec.remotePort}`);
  args.push('-p', String(device.port || 22));
  args.push(`${device.user}@${device.host}`);

  const previous = tunnelState.get(spec.name) || { restarts: 0 };
  const next = { status: 'starting', since: Date.now(), restarts: previous.restarts };
  tunnelState.set(spec.name, next);

  const proc = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  next.pid = proc.pid;
  proc.stderr.on('data', (chunk) => {
    const line = String(chunk).trim();
    if (line) console.error(`[ssh:${spec.name}] ${line}`);
    // ssh writes benign warnings (e.g. post-quantum notices) to stderr; keep
    // them as context but do not turn a live tunnel into an error state.
    const current = tunnelState.get(spec.name) || next;
    tunnelState.set(spec.name, { ...current, lastError: line.slice(0, 200) });
  });
  proc.on('spawn', () => tunnelState.set(spec.name, { ...next, status: 'up' }));
  proc.on('exit', (code, signal) => {
    const current = tunnelState.get(spec.name) || next;
    tunnelState.set(spec.name, { ...current, status: 'down', exitCode: code, signal });
    if (shuttingDown) return;
    setTimeout(() => { if (!shuttingDown) startTunnel({ ...spec, }); }, 3000).unref?.();
  });
  proc.on('error', (error) => {
    tunnelState.set(spec.name, { ...next, status: 'error', lastError: error.message });
  });
}

function tunnelMap() {
  return new Map(tunnelSpecs.map((spec) => [spec.remotePort, spec.localPort]));
}

function tunnelUrl(value, map) {
  try {
    const url = new URL(value);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      const local = map.get(Number(url.port));
      if (local) url.port = String(local);
    }
    return url;
  } catch {
    return new URL(value);
  }
}

// ---------------------------------------------------------------------------
// Upstreams. With a device configured, everything loopback is re-pointed at
// the SSH tunnel ports so the web page keeps working against the device.
// ---------------------------------------------------------------------------
let cooBaseUrl = new URL(process.env.SOLVER_COO_BASE_URL || config.cooBaseUrl || 'http://127.0.0.1:7797');
let corticoBaseUrl = new URL(process.env.SOLVER_CORTICO_BASE_URL || config.corticoBaseUrl || 'http://127.0.0.1:17788');
let hubBaseUrl = new URL(process.env.SOLVER_HUB_BASE_URL || config.hubBaseUrl || 'http://127.0.0.1:18100');

config.host = {
  ...config.host,
  address: process.env.SOLVER_PROJECTION_ADDRESS || config.host?.address || Object.values(os.networkInterfaces())
    .flatMap((items) => items || [])
    .find((item) => item.family === 'IPv4' && !item.internal && /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(item.address))?.address || null,
};
config.services = [
  ...(config.services || []),
  { id: 'hub', name: 'Absolute Solver Hub', type: 'hub', baseUrl: hubBaseUrl.toString(), healthPath: '/state', capabilities: ['body-routing', 'conversation', 'tts'] },
  { id: 'cortico', name: 'Cortico Core', type: 'cortico', baseUrl: corticoBaseUrl.toString(), healthPath: '/api/status', capabilities: ['persona', 'desktop-pet-chat', 'tts', 'audio-play'] },
];

if (deviceEnabled) {
  const map = tunnelMap();
  cooBaseUrl = tunnelUrl(cooBaseUrl.toString(), map);
  corticoBaseUrl = tunnelUrl(corticoBaseUrl.toString(), map);
  hubBaseUrl = tunnelUrl(hubBaseUrl.toString(), map);
  config.services = config.services.map((service) => ({
    ...service,
    baseUrl: tunnelUrl(service.baseUrl, map).toString(),
    interfaceUrl: service.interfaceUrl ? tunnelUrl(service.interfaceUrl, map).toString() : service.interfaceUrl,
  }));
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const ttsHandles = new Set();

function targetUrl(base, pathname, search = '') {
  return new URL(`${pathname}${search}`, base);
}

function proxyHttp(request, response, base, pathname, injectPetAudio = false) {
  const target = targetUrl(base, pathname, new URL(request.url || '/', 'http://projection').search);
  const headers = { ...request.headers, host: target.host, origin: request.headers.origin === 'null' ? 'null' : undefined };
  delete headers.origin;
  const upstream = http.request(target, { method: request.method, headers }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers };
    delete responseHeaders['content-length'];
    if (base === cooBaseUrl && request.headers.origin === 'null' && (pathname.startsWith('/web/') || pathname.startsWith('/packs/'))) {
      responseHeaders['access-control-allow-origin'] = 'null';
    }
    if (base === cooBaseUrl && responseHeaders['content-security-policy']) {
      responseHeaders['content-security-policy'] = rewriteCooCsp(responseHeaders['content-security-policy'], request.headers.host || 'localhost');
    }
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    const rewritePetScript = base === cooBaseUrl && pathname === '/web/pet-app.js';
    if ((!injectPetAudio && !rewritePetScript) || request.method === 'HEAD' || upstreamResponse.statusCode !== 200) {
      upstreamResponse.pipe(response);
      return;
    }
    const chunks = [];
    upstreamResponse.on('data', (chunk) => chunks.push(chunk));
    upstreamResponse.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');
      if (rewritePetScript) body = body.replace('ws://${location.host}', "${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}");
      if (injectPetAudio) body = body.replace(/<\/body>/i, '<script defer src="/coo-audio.js"></script></body>');
      response.end(body);
    });
  });
  upstream.on('error', (error) => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`upstream unavailable: ${error.message}`);
  });
  request.pipe(upstream);
}

function isCooPath(pathname) {
  return pathname === '/coo/pet' || pathname === '/figure-frame' || pathname.startsWith('/web/')
    || pathname.startsWith('/packs/') || pathname === '/api/state' || pathname === '/api/avatar'
    || pathname === '/api/figures' || pathname === '/api/figures/status' || pathname === '/api/speech'
    || pathname === '/api/prefs' || pathname === '/api/skin';
}

let WebSocket;
let WebSocketServer;
try {
  const require = createRequire(import.meta.url);
  const ws = require(process.env.SOLVER_WS_MODULE || 'ws');
  WebSocket = ws.WebSocket || ws;
  WebSocketServer = ws.WebSocketServer;
} catch {
  // The directory still serves services without websocket proxying when ws is absent.
}

// ---------------------------------------------------------------------------
// Face window: Live2D-first main page. SSE down from Cortico, HTTPS up into the
// same Coo Persona through a watcher socket, optional host ASR, model import.
// ---------------------------------------------------------------------------
const faceRoot = resolve(root, 'face');
const asrBaseUrl = new URL(process.env.SOLVER_ASR_BASE_URL || config.face?.asrBaseUrl || 'http://127.0.0.1:9881');
const faceBridge = createFaceBridge({
  cooBaseUrl,
  corticoBaseUrl,
  asrBaseUrl,
  faceRoot,
  ttsHandles,
  WebSocket,
});

const FACE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

const FACE_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.moc3': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8',
};

async function serveFaceStatic(request, response, pathname) {
  let rel = decodeURIComponent(pathname.replace(/^\/face\/?/, ''));
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const target = resolve(faceRoot, rel);
  if (target !== faceRoot && !target.startsWith(faceRoot + sep)) {
    response.writeHead(403).end();
    return;
  }
  let body;
  try {
    body = await readFile(target);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': FACE_MIME[extname(target).toLowerCase()] || 'application/octet-stream',
    'cache-control': rel.endsWith('index.html') ? 'no-cache' : 'public, max-age=60',
    'content-security-policy': FACE_CSP,
    'x-content-type-options': 'nosniff',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function proxySocket(request, socket, head, base, allowClientMessages, pathnameOverride = null) {
  if (!WebSocket || !WebSocketServer) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  const server = new WebSocketServer({ noServer: true });
  server.handleUpgrade(request, socket, head, (client) => {
    const incoming = new URL(request.url || '/', 'http://projection');
    const target = targetUrl(base, pathnameOverride || incoming.pathname, incoming.search);
    const upstream = new WebSocket(target.href.replace(/^http/, 'ws'), { origin: base.origin });
    const queued = [];
    client.on('message', (data, isBinary) => {
      if (!allowClientMessages) return;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WebSocket.CONNECTING) queued.push({ data, isBinary });
    });
    upstream.on('open', () => {
      for (const message of queued.splice(0)) upstream.send(message.data, { binary: message.isBinary });
    });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    const close = () => { try { client.close(); } catch {} try { upstream.close(); } catch {} };
    client.on('close', close);
    client.on('error', close);
    upstream.on('close', close);
    upstream.on('error', close);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function handleRequestInner(request, response) {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (pathname === '/api/health' && (request.method === 'GET' || request.method === 'HEAD')) {
    sendJson(response, 200, { ok: true, https: tlsEnabled, device: deviceEnabled });
    return;
  }
  if (pathname === '/api/device' && (request.method === 'GET' || request.method === 'HEAD')) {
    sendJson(response, 200, {
      schema: 1,
      tls: { enabled: tlsEnabled, httpsPort: tlsEnabled ? httpsPort : null },
      network: {
        lan: true,
        tailscale: tailscale ? { dnsName: tailscale.dnsName, ipv4: tailscale.ipv4, backendState: tailscale.backendState } : null,
      },
      device: deviceEnabled ? { host: device.host, port: device.port || 22, user: device.user, transport: 'ssh' } : null,
      tunnels: deviceEnabled ? tunnelSpecs.map((spec) => ({ name: spec.name, remotePort: spec.remotePort, localPort: spec.localPort, ...(tunnelState.get(spec.name) || { status: 'idle' }) })) : [],
    });
    return;
  }
  if (pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
    await serveFaceStatic(request, response, '/face/');
    return;
  }
  if ((pathname === '/figure' || pathname === '/figure/') && (request.method === 'GET' || request.method === 'HEAD')) {
    await serveFaceStatic(request, response, '/face/figure.html');
    return;
  }
  if (pathname === '/face' || pathname === '/face/' || pathname.startsWith('/face/')) {
    if (await faceBridge.handle(request, response, pathname)) return;
    if (request.method === 'GET' || request.method === 'HEAD') { await serveFaceStatic(request, response, pathname); return; }
    response.writeHead(405, { allow: 'GET, HEAD, POST' }).end();
    return;
  }
  if (pathname === '/coo/pet' || pathname === '/pet') {
    proxyHttp(request, response, cooBaseUrl, '/pet', true);
    return;
  }
  if (pathname === '/hub/app') {
    proxyHttp(request, response, hubBaseUrl, '/app');
    return;
  }
  if (isCooPath(pathname) && (request.method === 'GET' || request.method === 'HEAD' || (request.method === 'POST' && ['/api/speech', '/api/prefs', '/api/skin'].includes(pathname)))) {
    proxyHttp(request, response, cooBaseUrl, pathname);
    return;
  }
  if (pathname === '/cortico/event' && request.method === 'POST') {
    proxyHttp(request, response, hubBaseUrl, pathname);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  if (pathname === '/api/services') {
    const catalog = await buildCatalog(config);
    sendJson(response, 200, catalog);
    return;
  }
  if (pathname === '/api/coo/status') {
    try {
      const upstreamResponse = await fetch(new URL('/api/webui/manifest', corticoBaseUrl), { signal: AbortSignal.timeout(2500), redirect: 'error' });
      if (!upstreamResponse.ok) throw new Error(`Cortico HTTP ${upstreamResponse.status}`);
      const manifest = await upstreamResponse.json();
      const picked = ['world:desktop-pet', 'world:tts', 'world:audio-play'].map((id) => {
        const item = (manifest.providers || []).find((provider) => provider.id === id);
        return item ? {
          id,
          label: String(item.label || id),
          availability: ['active', 'inactive', 'missing', 'error'].includes(item.availability) ? item.availability : 'unknown',
          lamps: (Array.isArray(item.lamps) ? item.lamps : []).map((lamp) => ({
            label: String(lamp.label || ''),
            state: ['online', 'offline', 'loading', 'error'].includes(lamp.state) ? lamp.state : 'unknown',
            hint: String(lamp.hint || '').slice(0, 180),
          })),
          badges: (Array.isArray(item.badges) ? item.badges : []).map((badge) => ({
            label: String(badge.label || ''),
            value: String(badge.value || '').slice(0, 100),
            tone: ['on', 'off', 'error', 'warn'].includes(badge.tone) ? badge.tone : 'neutral',
          })),
        } : { id, label: id, availability: 'missing', lamps: [], badges: [] };
      });
      sendJson(response, 200, { providers: picked, checkedAt: new Date().toISOString() });
    } catch (error) {
      sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (pathname === '/api/coo/audio' && request.method === 'GET') {
    const afterValue = new URL(request.url || '/', 'http://projection').searchParams.get('after');
    try {
      if (afterValue === null) {
        const initial = await fetch(new URL('/api/events?limit=1', corticoBaseUrl), { signal: AbortSignal.timeout(2500), redirect: 'error' });
        if (!initial.ok) throw new Error(`Cortico HTTP ${initial.status}`);
        const state = await initial.json();
        sendJson(response, 200, { latest: Number(state.latest) || 0, nextAfter: Number(state.latest) || 0, more: false, voices: [] });
        return;
      }
      const after = Number.parseInt(afterValue, 10);
      if (!Number.isSafeInteger(after) || after < 0) { response.writeHead(400).end(); return; }
      const query = `?from=${after + 1}&limit=40&archive=1&source=tts`;
      const upstreamResponse = await fetch(new URL(`/api/events${query}`, corticoBaseUrl), { signal: AbortSignal.timeout(2500), redirect: 'error' });
      if (!upstreamResponse.ok) throw new Error(`Cortico HTTP ${upstreamResponse.status}`);
      const payload = await upstreamResponse.json();
      const voices = (Array.isArray(payload.events) ? payload.events : []).flatMap((event) => {
        if (event?.type !== 'tts.voice' || !Array.isArray(event.blobs)) return [];
        return event.blobs.filter((blob) => typeof blob?.handle === 'string' && typeof blob?.mime === 'string' && blob.mime.startsWith('audio/')).map((blob) => {
          ttsHandles.add(blob.handle);
          while (ttsHandles.size > 1000) ttsHandles.delete(ttsHandles.values().next().value);
          return { cursor: event.cursor, mime: blob.mime, url: `/api/coo/blob?handle=${encodeURIComponent(blob.handle)}` };
        });
      });
      const pageEvents = Array.isArray(payload.events) ? payload.events : [];
      sendJson(response, 200, {
        latest: Number(payload.latest) || 0,
        nextAfter: payload.hasMore && pageEvents.length ? Number(pageEvents[pageEvents.length - 1].cursor) || after : Number(payload.latest) || after,
        more: payload.hasMore === true,
        voices,
      });
    } catch (error) {
      sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (pathname === '/api/coo/blob' && request.method === 'GET') {
    const handle = new URL(request.url || '/', 'http://projection').searchParams.get('handle') || '';
    if (!ttsHandles.has(handle)) { response.writeHead(404).end(); return; }
    try {
      const upstream = await fetch(new URL(`/api/blob?handle=${encodeURIComponent(handle)}`, corticoBaseUrl), { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!upstream.ok || !upstream.body) { response.writeHead(upstream.status || 502).end(); return; }
      response.writeHead(200, {
        'content-type': upstream.headers.get('content-type') || 'audio/wav',
        'cache-control': 'private, max-age=60',
        'x-content-type-options': 'nosniff',
      });
      const reader = upstream.body.getReader();
      try { while (true) { const { done, value } = await reader.read(); if (done) break; response.write(value); } } finally { response.end(); }
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
    return;
  }
  if (pathname === '/coo-audio.js' && request.method === 'GET') {
    const body = await readFile(resolve(root, 'coo-audio.js'));
    response.writeHead(200, { 'content-type': mime['.js'], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    response.end(body);
    return;
  }
  const fileName = pathname === '/services' ? 'projection.html' : pathname.slice(1);
  if (!['projection.html', 'projection.js', 'projection.css'].includes(fileName) || (pathname !== '/services' && !pathname.startsWith('/projection.'))) {
    response.writeHead(404).end();
    return;
  }
  const body = await readFile(resolve(root, fileName));
  const ext = fileName.slice(fileName.lastIndexOf('.'));
  response.writeHead(200, {
    'content-type': mime[ext],
    'cache-control': 'no-cache',
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function handleUpgrade(request, socket, head) {
  const pathname = new URL(request.url || '/', 'http://projection').pathname;
  if (pathname === '/ws') return proxySocket(request, socket, head, hubBaseUrl, true);
  if (pathname === '/socket') return proxySocket(request, socket, head, cooBaseUrl, true);
  socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
}

let tlsEnabled = false;
let tlsMaterial = null;

async function ensureCertificate() {
  if (!httpsPrimary) return null;
  if (existsSync(tlsCertPath) && existsSync(tlsKeyPath)) {
    return { cert: await readFile(tlsCertPath), key: await readFile(tlsKeyPath) };
  }
  const dir = dirname(tlsCertPath);
  mkdirSync(dir, { recursive: true });
  const commonName = config.tls?.commonName || 'absolute-solver.local';
  const addresses = Object.values(os.networkInterfaces()).flatMap((items) => items || []).map((item) => item.address).filter(Boolean);
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...addresses.filter((address) => address.includes('.')).map((address) => `IP:${address}`)].join(',');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', tlsKeyPath, '-out', tlsCertPath, '-days', '825',
    '-subj', `/CN=${commonName}`,
    '-addext', `subjectAltName=${san}`,
  ], { stdio: 'ignore' });
  console.log(`Generated self-signed certificate at ${tlsCertPath}`);
  return { cert: await readFile(tlsCertPath), key: await readFile(tlsKeyPath) };
}

function handleRequest(request, response) {
  // Loopback callers (tailscale serve, local tools) are already inside the
  // trusted boundary; only direct non-loopback clients get pushed to HTTPS.
  // Opt out with tls.redirectHttp=false / SOLVER_PROJECTION_ALLOW_HTTP=1 when a
  // device cannot accept the self-signed certificate (SSE works, mic will not).
  const allowPlainHttp = config.tls?.redirectHttp === false || process.env.SOLVER_PROJECTION_ALLOW_HTTP === '1';
  if (tlsEnabled && httpsPrimary && !allowPlainHttp && !request.socket.encrypted && !isLoopbackAddress(request.socket.remoteAddress)) {
    const hostHeader = (request.headers.host || '').split(':')[0] || 'localhost';
    response.writeHead(308, { location: `https://${hostHeader}:${httpsPort}${request.url || '/'}` });
    response.end();
    return;
  }
  handleRequestInner(request, response).catch((error) => {
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`internal error: ${error instanceof Error ? error.message : String(error)}`);
  });
}

if (deviceEnabled) {
  console.log(`SSH device: ${device.user}@${device.host}:${device.port || 22}`);
  for (const spec of tunnelSpecs) startTunnel(spec);
}

try {
  tlsMaterial = await ensureCertificate();
  tlsEnabled = Boolean(tlsMaterial);
} catch (error) {
  console.warn(`HTTPS disabled: ${error instanceof Error ? error.message : String(error)}`);
}

const httpServer = http.createServer(handleRequest);
httpServer.on('upgrade', handleUpgrade);
httpServer.listen(httpPort, host, () => console.log(`Host projection HTTP listening on http://${host}:${httpServer.address().port}`));

faceBridge.ready()
  .then((info) => console.log(`Face window ready: ${info.models.length} model(s), default ${info.default}, importer ${info.converterReady ? 'ok' : 'missing'}`))
  .catch((error) => console.warn(`Face window init: ${error.message}`));

if (tlsEnabled) {
  const httpsServer = https.createServer(tlsMaterial, handleRequest);
  httpsServer.on('upgrade', handleUpgrade);
  httpsServer.listen(httpsPort, host, () => console.log(`Host projection HTTPS listening on https://${host}:${httpsServer.address().port}`));
}

function shutdown() {
  shuttingDown = true;
  try { faceBridge.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

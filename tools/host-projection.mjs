import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildCatalog, rewriteCooCsp } from './host-projection-lib.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const localConfigPath = `${root}/host-projection.local.json`;
const configPath = resolve(process.env.SOLVER_PROJECTION_CONFIG || (existsSync(localConfigPath) ? localConfigPath : `${root}/host-projection.example.json`));
const config = JSON.parse(await readFile(configPath, 'utf8'));
const host = process.env.SOLVER_PROJECTION_HOST || config.listenHost || '0.0.0.0';
const port = Number(process.env.SOLVER_PROJECTION_PORT || config.listenPort || 18110);
const tlsPort = Number(process.env.SOLVER_PROJECTION_TLS_PORT || 18112);
const tlsCertPath = process.env.SOLVER_PROJECTION_TLS_CERT || '';
const tlsKeyPath = process.env.SOLVER_PROJECTION_TLS_KEY || '';
const cooBaseUrl = new URL(process.env.SOLVER_COO_BASE_URL || config.cooBaseUrl || 'http://127.0.0.1:7797');
const corticoBaseUrl = new URL(process.env.SOLVER_CORTICO_BASE_URL || config.corticoBaseUrl || 'http://127.0.0.1:17788');
const hubBaseUrl = new URL(process.env.SOLVER_HUB_BASE_URL || config.hubBaseUrl || 'http://127.0.0.1:18100');
const hostAddress = process.env.SOLVER_PROJECTION_ADDRESS || config.host?.address || Object.values(os.networkInterfaces())
  .flatMap((items) => items || [])
  .find((item) => item.family === 'IPv4' && !item.internal && /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(item.address))?.address || null;
config.host = { ...config.host, address: hostAddress };
config.services = [
  ...(config.services || []),
  { id: 'hub', name: 'Absolute Solver Hub', type: 'hub', baseUrl: hubBaseUrl.toString(), healthPath: '/state', capabilities: ['body-routing', 'conversation', 'tts'] },
  { id: 'cortico', name: 'Cortico Core', type: 'cortico', baseUrl: corticoBaseUrl.toString(), healthPath: '/api/status', capabilities: ['persona', 'desktop-pet-chat', 'tts', 'audio-play'] },
];
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

async function handleRequest(request, response) {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
    proxyHttp(request, response, cooBaseUrl, '/pet', true);
    return;
  }
  if (pathname === '/coo/pet') {
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
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(catalog));
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
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ providers: picked, checkedAt: new Date().toISOString() }));
    } catch (error) {
      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
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
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ latest: Number(state.latest) || 0, nextAfter: Number(state.latest) || 0, more: false, voices: [] }));
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
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({
        latest: Number(payload.latest) || 0,
        nextAfter: payload.hasMore && pageEvents.length ? Number(pageEvents[pageEvents.length - 1].cursor) || after : Number(payload.latest) || after,
        more: payload.hasMore === true,
        voices,
      }));
    } catch (error) {
      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
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

const server = http.createServer(handleRequest);
server.on('upgrade', handleUpgrade);
server.listen(port, host, () => console.log(`Host projection listening on http://${host}:${server.address().port}`));

if (tlsCertPath && tlsKeyPath) {
  const tlsServer = https.createServer({ cert: await readFile(tlsCertPath), key: await readFile(tlsKeyPath) }, handleRequest);
  tlsServer.on('upgrade', handleUpgrade);
  tlsServer.listen(tlsPort, host, () => console.log(`Host projection listening on https://${host}:${tlsServer.address().port}`));
}

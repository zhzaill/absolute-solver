import http from 'node:http';
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
const cooBaseUrl = new URL(process.env.SOLVER_COO_BASE_URL || config.cooBaseUrl || 'http://127.0.0.1:7797');
const hubBaseUrl = new URL(process.env.SOLVER_HUB_BASE_URL || config.hubBaseUrl || 'http://127.0.0.1:18100');
const hostAddress = process.env.SOLVER_PROJECTION_ADDRESS || config.host?.address || Object.values(os.networkInterfaces())
  .flatMap((items) => items || [])
  .find((item) => item.family === 'IPv4' && !item.internal && /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(item.address))?.address || null;
config.host = { ...config.host, address: hostAddress };
config.services = [
  ...(config.services || []),
  { id: 'hub', name: 'Absolute Solver Hub', type: 'hub', baseUrl: hubBaseUrl.toString(), healthPath: '/state', capabilities: ['body-routing', 'conversation', 'tts'] },
];
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function targetUrl(base, pathname, search = '') {
  return new URL(`${pathname}${search}`, base);
}

function proxyHttp(request, response, base, pathname) {
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
    upstreamResponse.pipe(response);
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
    || pathname === '/api/figures' || pathname === '/api/figures/status' || pathname === '/api/speech';
}

function isHubPath(pathname) {
  return pathname === '/hub/app' || pathname === '/cortico/event';
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

function proxySocket(request, socket, head, base, allowClientMessages) {
  if (!WebSocket || !WebSocketServer) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  const server = new WebSocketServer({ noServer: true });
  server.handleUpgrade(request, socket, head, (client) => {
    const target = targetUrl(base, new URL(request.url || '/', 'http://projection').pathname, new URL(request.url || '/', 'http://projection').search);
    const upstream = new WebSocket(target.href.replace(/^http/, 'ws'), { origin: base.origin });
    upstream.on('open', () => {
      client.on('message', (data, isBinary) => {
        if (allowClientMessages && upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      });
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

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (pathname === '/coo/pet') {
    proxyHttp(request, response, cooBaseUrl, '/pet');
    return;
  }
  if (pathname === '/hub/app') {
    proxyHttp(request, response, hubBaseUrl, '/app');
    return;
  }
  if (isCooPath(pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
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
  const fileName = pathname === '/' ? 'projection.html' : pathname.slice(1);
  if (!['projection.html', 'projection.js', 'projection.css'].includes(fileName)) {
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
});

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', 'http://projection').pathname;
  if (pathname === '/ws') return proxySocket(request, socket, head, hubBaseUrl, true);
  if (pathname === '/socket') return proxySocket(request, socket, head, cooBaseUrl, false);
  socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
});
server.listen(port, host, () => console.log(`Host projection listening on http://${host}:${server.address().port}`));

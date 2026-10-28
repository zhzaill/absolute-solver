import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildCatalog } from './host-projection-lib.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(process.env.SOLVER_PROJECTION_CONFIG || `${root}/host-projection.example.json`);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const host = process.env.SOLVER_PROJECTION_HOST || config.listenHost || '0.0.0.0';
const port = Number(process.env.SOLVER_PROJECTION_PORT || config.listenPort || 18110);
const hostAddress = process.env.SOLVER_PROJECTION_ADDRESS || config.host?.address || Object.values(os.networkInterfaces())
  .flatMap((items) => items || [])
  .find((item) => item.family === 'IPv4' && !item.internal && /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(item.address))?.address || null;
config.host = { ...config.host, address: hostAddress };
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
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

server.listen(port, host, () => console.log(`Host projection listening on http://${host}:${server.address().port}`));

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..', 'body-panel');
const port = Number(process.env.PANEL_PORT || process.argv[2] || 5274);
const hubWs = process.env.HUB_WS_URL || 'ws://127.0.0.1:18100/ws';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
};

async function resolveFile(pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = normalize(resolve(root, relative));
  if (file !== root && !file.startsWith(root + sep)) return null;
  try { return (await stat(file)).isFile() ? file : null; } catch { return null; }
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url || '/', `http://127.0.0.1:${port}`).pathname);
    const file = await resolveFile(pathname);
    if (!file) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`404 ${pathname}`);
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': types[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(String(error));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(
    `Body panel: http://127.0.0.1:${server.address().port}/?hub=${encodeURIComponent(hubWs)}`,
  );
});

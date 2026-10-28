import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, probeService, rewriteCooCsp, safeAddress } from './host-projection-lib.mjs';

test('public addresses remove credentials, query strings, and fragments', () => {
  assert.equal(safeAddress('http://user:secret@127.0.0.1:8080/path?token=x#frag'), 'http://127.0.0.1:8080/path');
  assert.equal(safeAddress('file:///secret'), null);
});

test('service health is based on the endpoint response, not configuration presence', async () => {
  const config = {
    host: { id: 'host-a', name: 'Host A' },
    services: [{ id: 'coo', name: 'Coo', baseUrl: 'http://127.0.0.1:7797', healthPath: '/api/state', interfaceUrl: 'http://127.0.0.1:7797/pet', capabilities: ['pet-renderer'] }],
  };
  const catalog = await buildCatalog(config, async () => new Response('{}', { status: 200 }));
  assert.equal(catalog.services[0].status, 'online');
  assert.equal(catalog.services[0].reachability, 'host-local');
  assert.equal(catalog.services[0].interfaceUrl, null);
  const offline = await buildCatalog(config, async () => { throw new Error('offline'); });
  assert.equal(offline.services[0].status, 'offline');
  assert.equal(offline.services[0].interfaceUrl, null);
});

test('invalid or missing health endpoints remain unknown', async () => {
  assert.deepEqual(await probeService({ baseUrl: 'not a url', healthPath: '/' }), { status: 'unknown', latencyMs: null });
  assert.deepEqual(await probeService({ baseUrl: 'http://127.0.0.1:1' }), { status: 'unknown', latencyMs: null });
  assert.equal((await probeService({ baseUrl: 'http://127.0.0.1:7797', healthPath: '//example.com' })).status, 'unknown');
});

test('Coo CSP allows same-origin framing and the projected websocket only', () => {
  const policy = rewriteCooCsp("default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'self' http://127.0.0.1:*", '192.168.1.178:18111');
  assert.match(policy, /frame-ancestors 'self'/);
  assert.match(policy, /ws:\/\/192\.168\.1\.178:18111/);
  assert.doesNotMatch(policy, /127\.0\.0\.1|localhost/);
});

test('Coo sandbox CSP does not retain none alongside projected sources', () => {
  const policy = rewriteCooCsp("sandbox allow-scripts; default-src 'none'; script-src http://127.0.0.1:7797; img-src http://127.0.0.1:7797 data:; style-src 'unsafe-inline'; connect-src 'none'; frame-ancestors http://127.0.0.1:*", '192.168.1.178:18111');
  assert.doesNotMatch(policy, /connect-src 'none'/);
  assert.match(policy, /connect-src 'self' ws:\/\/192\.168\.1\.178:18111/);
  assert.match(policy, /frame-ancestors 'self'/);
});

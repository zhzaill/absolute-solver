import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessAgent } from './access-agent.mjs';

test('agent exposes only fixed routes and forwards after one grant', async t => {
  const calls = [];
  let claimed;
  const hub = await start(async (req, res) => {
    calls.push(req.url);
    if (req.url === '/access/claim') {
      claimed = JSON.parse(await read(req));
      return respond(res, { request_id: 'r1', source_instance: 'cortico', target_host_id: 'host-a', target_service: 'tts', operation: 'speech.synthesize', status: 'consumed' });
    }
    if (req.url === '/access/result') return respond(res, { ok: true }, 202);
    return respond(res, {}, 404);
  });
  const upstream = await start(async (req, res) => { assert.equal(req.url, '/v1/audio/speech'); respond(res, { ok: true }, 200, 'audio/wav'); });
  const agent = createAccessAgent({ hubUrl: hub.url, hubToken: 'secret', hostId: 'host-a', proxyToken: 'proxy', ttsUpstream: upstream.url, asrUpstream: upstream.url });
  await listen(agent); const agentUrl = `http://127.0.0.1:${agent.address().port}`; t.after(() => agent.close()); t.after(() => hub.server.close()); t.after(() => upstream.server.close());
  const denied = await fetch(`${agentUrl}/anything`, { method: 'POST' }); assert.equal(denied.status, 401);
  const fixedOnly = await fetch(`${agentUrl}/anything`, { method: 'POST', headers: { authorization: 'Bearer proxy' } }); assert.equal(fixedOnly.status, 404);
  const unauthorized = await fetch(`${agentUrl}/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(unauthorized.status, 401);
  const response = await fetch(`${agentUrl}/v1/audio/speech`, { method: 'POST', headers: { authorization: 'Bearer proxy', 'content-type': 'application/json', 'x-solver-source-instance': 'forged-source' }, body: '{}' });
  assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  assert.deepEqual(claimed, { source_instance: 'cortico', target_host_id: 'host-a', target_service: 'tts', operation: 'speech.synthesize' });
  assert.deepEqual(calls, ['/access/claim', '/access/result']);
});

test('agent spends the carried approval and never invents a second one', async t => {
  const claims = [];
  const hub = await start(async (req, res) => {
    const body = JSON.parse(await read(req));
    if (req.url === '/access/claim') {
      claims.push(body);
      // Hub echoes the exact approval the plugin carried.
      return respond(res, { request_id: body.request_id, source_instance: body.source_instance, target_host_id: body.target_host_id, target_service: body.target_service, operation: body.operation, status: 'consumed' });
    }
    if (req.url === '/access/result') return respond(res, { ok: true }, 202);
    return respond(res, {}, 404);
  });
  const upstream = await start(async (req, res) => respond(res, { ok: true }, 200, 'audio/wav'));
  const agent = createAccessAgent({ hubUrl: hub.url, hubToken: 'secret', hostId: 'host-a', proxyToken: 'proxy', ttsUpstream: upstream.url, asrUpstream: upstream.url });
  await listen(agent); const agentUrl = `http://127.0.0.1:${agent.address().port}`;
  t.after(() => agent.close()); t.after(() => hub.server.close()); t.after(() => upstream.server.close());

  const approved = await fetch(`${agentUrl}/v1/audio/speech`, { method: 'POST', headers: { authorization: 'Bearer proxy', 'content-type': 'application/json', 'x-solver-request-id': 'coo-access-123-abc' }, body: '{}' });
  assert.equal(approved.status, 200);
  // The approval travels through verbatim: the agent creates nothing of its own.
  assert.equal(claims.length, 1);
  assert.equal(claims[0].request_id, 'coo-access-123-abc');

  // A malformed identifier is refused before any hub or upstream traffic.
  const malformed = await fetch(`${agentUrl}/v1/audio/speech`, { method: 'POST', headers: { authorization: 'Bearer proxy', 'content-type': 'application/json', 'x-solver-request-id': 'not a request id' }, body: '{}' });
  assert.equal(malformed.status, 400);
  assert.equal(claims.length, 1);
});

test('agent reports a rejected approval as a local denial, not an upstream call', async t => {
  const upstreamRequests = [];
  const hub = await start(async (req, res) => {
    if (req.url === '/access/claim') return respond(res, { error: 'RouteMismatch' }, 409);
    return respond(res, { ok: true }, 202);
  });
  const upstream = await start(async (req, res) => { upstreamRequests.push(req.url); respond(res, {}, 200); });
  const agent = createAccessAgent({ hubUrl: hub.url, hubToken: 'secret', hostId: 'host-a', proxyToken: 'proxy', ttsUpstream: upstream.url, asrUpstream: upstream.url });
  await listen(agent); const agentUrl = `http://127.0.0.1:${agent.address().port}`;
  t.after(() => agent.close()); t.after(() => hub.server.close()); t.after(() => upstream.server.close());
  const response = await fetch(`${agentUrl}/v1/audio/speech`, { method: 'POST', headers: { authorization: 'Bearer proxy', 'content-type': 'application/json', 'x-solver-request-id': 'someone-elses-approval' }, body: '{}' });
  assert.equal(response.status, 403);
  assert.deepEqual(upstreamRequests, []);
});

test('agent reports upstream transport failure as a 502 result', async t => {
  const results = [];
  const hub = await start(async (req, res) => {
    if (req.url === '/access/claim') return respond(res, { request_id: 'existing_request', source_instance: 'cortico', target_host_id: 'host-a', target_service: 'tts', operation: 'speech.synthesize', status: 'consumed' });
    if (req.url === '/access/result') { results.push(JSON.parse(await read(req))); return respond(res, { ok: true }, 202); }
    return respond(res, {}, 404);
  });
  const agent = createAccessAgent({
    hubUrl: hub.url,
    hubToken: 'secret',
    hostId: 'host-a',
    proxyToken: 'proxy',
    fetchImpl: async () => { throw new Error('upstream unavailable'); },
  });
  await listen(agent);
  const agentUrl = `http://127.0.0.1:${agent.address().port}`;
  t.after(() => agent.close());
  t.after(() => hub.server.close());
  const response = await fetch(`${agentUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: { authorization: 'Bearer proxy', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 502);
  assert.deepEqual(results.map(result => result.http_status), [502]);
  assert.equal(results[0].request_id, 'existing_request');
});

test('agent does not reach upstream when there is no unique approved request', async t => {
  const upstreamRequests = [];
  const hub = await start(async (req, res) => {
    assert.equal(req.url, '/access/claim');
    return respond(res, { error: 'AmbiguousGrant' }, 409);
  });
  const upstream = await start(async (req, res) => { upstreamRequests.push(req.url); respond(res, {}, 200); });
  const agent = createAccessAgent({ hubUrl: hub.url, hubToken: 'secret', hostId: 'host-a', proxyToken: 'proxy', ttsUpstream: upstream.url });
  await listen(agent);
  const agentUrl = `http://127.0.0.1:${agent.address().port}`;
  t.after(() => agent.close());
  t.after(() => hub.server.close());
  t.after(() => upstream.server.close());
  const response = await fetch(`${agentUrl}/v1/audio/speech`, { method: 'POST', headers: { authorization: 'Bearer proxy', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
  assert.deepEqual(upstreamRequests, []);
});

function respond(res, value, status = 200, type = 'application/json') { const body = Buffer.from(JSON.stringify(value)); res.writeHead(status, { 'content-type': type }); res.end(body); }
async function read(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8'); }
async function start(handler) { const server = (await import('node:http')).createServer(handler); await listen(server); return { server, url: `http://127.0.0.1:${server.address().port}` }; }
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }

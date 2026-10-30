import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalRegistry, createCooAccessBroker } from './coo-access-broker.mjs';

const AUTHORIZED = { authorization: 'Bearer broker' };

test('an unregistered approval is never spent and never forwarded', async t => {
  const upstream = [];
  const hub = await start(async (req, res) => respond(res, { status: 'granted' }));
  const agent = await start(async (req, res) => { upstream.push(req.url); respond(res, {}, 200); });
  const broker = createCooAccessBroker({ hubUrl: hub.url, hubToken: 'hub', brokerToken: 'broker', agentToken: 'agent', agentUrl: agent.url });
  await listen(broker); const brokerUrl = `http://127.0.0.1:${broker.address().port}`;
  t.after(() => broker.close()); t.after(() => hub.server.close()); t.after(() => agent.server.close());

  const response = await fetch(`${brokerUrl}/v1/audio/speech`, { method: 'POST', headers: { ...AUTHORIZED, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'no_approved_request');
  assert.deepEqual(upstream, [], 'the agent must never be reached without a known approval');
});

test('the broker attaches exactly the approval it registered, not a guess', async t => {
  const seen = [];
  const hub = await start(async (req, res) => {
    if (req.url.startsWith('/access/state/')) return respond(res, { request_id: 'r1', status: 'consumed' });
    return respond(res, {}, 404);
  });
  const agent = await start(async (req, res) => { seen.push({ url: req.url, requestId: req.headers['x-solver-request-id'], auth: req.headers.authorization }); respond(res, { ok: true }, 200, 'audio/wav'); });
  const broker = createCooAccessBroker({ hubUrl: hub.url, hubToken: 'hub', brokerToken: 'broker', agentToken: 'agent', agentUrl: agent.url });
  await listen(broker); const brokerUrl = `http://127.0.0.1:${broker.address().port}`;
  t.after(() => broker.close()); t.after(() => hub.server.close()); t.after(() => agent.server.close());

  const registered = await fetch(`${brokerUrl}/solver/approvals`, { method: 'POST', headers: { ...AUTHORIZED, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'coo-access-1-abc', service: 'tts', hostId: 'host-a', expiresAtMs: Date.now() + 60_000 }) });
  assert.equal(registered.status, 201);

  const response = await fetch(`${brokerUrl}/v1/audio/speech`, { method: 'POST', headers: { ...AUTHORIZED, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-solver-access-state'), 'consumed');
  assert.deepEqual(seen, [{ url: '/v1/audio/speech', requestId: 'coo-access-1-abc', auth: 'Bearer agent' }]);

  // Consumed is terminal: the approval is gone and the next call is refused.
  const again = await fetch(`${brokerUrl}/v1/audio/speech`, { method: 'POST', headers: { ...AUTHORIZED, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(again.status, 403);
  assert.equal(seen.length, 1);
});

test('a denied approval stops early and is not retried into an upstream call', async t => {
  const upstream = [];
  const hub = await start(async (req, res) => respond(res, { request_id: 'd1', status: 'denied' }));
  const agent = await start(async (req, res) => { upstream.push(req.url); respond(res, { error: 'no_approved_request' }, 403); });
  const broker = createCooAccessBroker({ hubUrl: hub.url, hubToken: 'hub', brokerToken: 'broker', agentToken: 'agent', agentUrl: agent.url });
  await listen(broker); const brokerUrl = `http://127.0.0.1:${broker.address().port}`;
  t.after(() => broker.close()); t.after(() => hub.server.close()); t.after(() => agent.server.close());

  await fetch(`${brokerUrl}/solver/approvals`, { method: 'POST', headers: { ...AUTHORIZED, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'd1', service: 'tts', hostId: 'host-a', expiresAtMs: Date.now() + 60_000 }) });
  const response = await fetch(`${brokerUrl}/v1/audio/speech`, { method: 'POST', headers: { ...AUTHORIZED, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
  const snapshot = await (await fetch(`${brokerUrl}/solver/approvals`, { headers: AUTHORIZED })).json();
  assert.deepEqual(snapshot.approvals, [], 'a denied approval is terminal');
});

test('registration refuses to widen its shape', async t => {
  const hub = await start(async (req, res) => respond(res, {}));
  const broker = createCooAccessBroker({ hubUrl: hub.url, hubToken: 'hub', brokerToken: 'broker', agentToken: 'agent', agentUrl: 'http://127.0.0.1:1' });
  await listen(broker); const brokerUrl = `http://127.0.0.1:${broker.address().port}`;
  t.after(() => broker.close()); t.after(() => hub.server.close());

  const register = body => fetch(`${brokerUrl}/solver/approvals`, { method: 'POST', headers: { ...AUTHORIZED, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await register({ requestId: 'bad id!', service: 'tts', hostId: 'h' })).status, 400);
  assert.equal((await register({ requestId: 'ok', service: 'shell', hostId: 'h' })).status, 400);
  assert.equal((await register({ requestId: 'ok', service: 'tts', hostId: '' })).status, 400);
  assert.equal((await register({ requestId: 'ok', service: 'tts', hostId: 'h' })).status, 201);
  assert.equal((await register({ requestId: 'ok', service: 'tts', hostId: 'h' })).status, 400, 'duplicates are refused');
  assert.equal((await fetch(`${brokerUrl}/solver/approvals`)).status, 401);
});

test('two ready approvals for one service are ambiguous, so neither is spent', () => {
  const registry = new ApprovalRegistry();
  registry.register({ requestId: 'a', service: 'tts', hostId: 'h', expiresAtMs: Date.now() + 60_000 });
  assert.equal(registry.take('tts', Date.now())?.requestId, 'a');
  registry.release('a');
  registry.register({ requestId: 'b', service: 'tts', hostId: 'h', expiresAtMs: Date.now() + 60_000 });
  assert.equal(registry.take('tts', Date.now()), null, 'ambiguity fails closed');
  // ASR is an independent lane.
  registry.register({ requestId: 'c', service: 'asr', hostId: 'h', expiresAtMs: Date.now() + 60_000 });
  assert.equal(registry.take('asr', Date.now())?.requestId, 'c');
});

test('an expired approval is not spendable', () => {
  const registry = new ApprovalRegistry();
  registry.register({ requestId: 'a', service: 'tts', hostId: 'h', expiresAtMs: 1000 });
  assert.equal(registry.take('tts', 2000), null);
});

function respond(res, value, status = 200, type = 'application/json') { const body = Buffer.from(JSON.stringify(value)); res.writeHead(status, { 'content-type': type }); res.end(body); }
async function start(handler) { const server = (await import('node:http')).createServer(handler); await listen(server); return { server, url: `http://127.0.0.1:${server.address().port}` }; }
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }

import test from 'node:test';
import assert from 'node:assert/strict';
import { AbsoluteSolverWorld } from '../src/world.js';

test('invalid directory URLs do not become fetch targets', async () => {
  const world = new AbsoluteSolverWorld({ cfg: { directoryUrl: 'javascript:alert(1)' } });
  const result = await world.readServices();
  assert.equal(result.failed, true);
  assert.match(result.text, /地址无效/);
});

test('world exposes a read-only service tool and summarizes the directory', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    checkedAt: '2026-10-28T00:00:00.000Z',
    host: { address: '192.168.1.178' },
    services: [{ id: 'tts', name: 'TTS', type: 'tts', status: 'online', host: { name: 'Solver Host' }, capabilities: ['speech-synthesis'], version: 'unknown' }],
  }), { status: 200 });
  try {
    const world = new AbsoluteSolverWorld({ cfg: { directoryUrl: 'http://192.168.1.178:18111' } });
    const tool = world.tools()[0];
    const result = await tool.handler({});
    assert.equal(result.failed, undefined);
    assert.match(result.text, /speech-synthesis/);
    assert.equal(world.envPromptVars()['absolute-solver.projectionUrl'], 'http://192.168.1.178:18111');
    assert.equal(world.envPromptVars()['absolute-solver.directoryUrl'], 'http://192.168.1.178:18111/services');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('webUi exposes the projection page and derived service directory', () => {
  const world = new AbsoluteSolverWorld({ cfg: { directoryUrl: 'http://192.168.1.178:18111' } });
  const view = world.webUi();
  assert.equal(view.badges[0].label, '投影网页');
  assert.deepEqual(view.links.map((link) => link.href), [
    'http://192.168.1.178:18111',
    'http://192.168.1.178:18111/services',
  ]);
  assert.match(view.promptDocs[0].description, /投影网页/);
  assert.deepEqual(view.promptDocs[0].vars.map((item) => item.name), [
    'absolute-solver.projectionUrl',
    'absolute-solver.directoryUrl',
    'absolute-solver.status',
    'absolute-solver.access',
  ]);
});

test('access tools request and summarize a grant without exposing its token', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push([url, init]);
    if (String(url).endsWith('/access/request')) return new Response(JSON.stringify({ request_id: 'r1', expires_at_ms: 1234 }), { status: 202 });
    if (String(url).endsWith('/solver/approvals')) return new Response(JSON.stringify({ requestId: 'r1', status: 'ready' }), { status: 201 });
    return new Response(JSON.stringify({ request_id: 'r1', target_host_id: 'server', target_service: 'tts', operation: 'speech.synthesize', status: 'granted', grant_id: 'secret-grant' }), { status: 200 });
  };
  try {
    const world = new AbsoluteSolverWorld({ cfg: { accessHubUrl: 'http://hub', accessBrokerUrl: 'http://127.0.0.1:18081', targetHostId: 'server', accessTokenSecret: 'TOKEN', accessBrokerTokenSecret: 'BROKER' }, secret: name => name === 'TOKEN' ? 'hub-secret' : name === 'BROKER' ? 'broker-secret' : '' });
    const request = await world.tools().find(tool => tool.name === 'solver_request_access').handler({ targetService: 'tts', purpose: 'speak' });
    assert.equal(request.status, 'pending');
    assert.equal(request.spendable, true);
    const status = await world.tools().find(tool => tool.name === 'solver_access_status').handler({ requestId: 'r1' });
    assert.equal(status.status, 'granted');
    assert.equal(status.grantId, undefined);
    assert.equal(calls[0][1].headers.authorization, 'Bearer hub-secret');
    // The approval is registered with the broker using its own secret, never the Hub one.
    assert.equal(calls[1][0], 'http://127.0.0.1:18081/solver/approvals');
    assert.equal(calls[1][1].headers.authorization, 'Bearer broker-secret');
    assert.deepEqual(JSON.parse(calls[1][1].body), { requestId: 'r1', service: 'tts', hostId: 'server', expiresAtMs: 1234 });
  } finally { globalThis.fetch = originalFetch; }
});

test('an approval the broker refused is reported as unusable, not as ready', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/access/request')) return new Response(JSON.stringify({ request_id: 'r2', expires_at_ms: 9999 }), { status: 202 });
    return new Response(JSON.stringify({ error: 'duplicate_approval' }), { status: 400 });
  };
  try {
    const world = new AbsoluteSolverWorld({ cfg: { accessHubUrl: 'http://hub', accessBrokerUrl: 'http://127.0.0.1:18081', targetHostId: 'server', accessTokenSecret: 'TOKEN', accessBrokerTokenSecret: 'BROKER' }, secret: () => 'x' });
    const request = await world.tools().find(tool => tool.name === 'solver_request_access').handler({ targetService: 'tts', purpose: 'speak' });
    assert.equal(request.failed, true);
    assert.equal(request.spendable, false);
    assert.match(request.text, /不会被使用/);
    assert.equal(world.envPromptVars()['absolute-solver.access'].includes('pending'), true);
  } finally { globalThis.fetch = originalFetch; }
});

test('with no broker configured the request is still created but marked unspendable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ request_id: 'r3', expires_at_ms: 9999 }), { status: 202 });
  try {
    const world = new AbsoluteSolverWorld({ cfg: { accessHubUrl: 'http://hub', targetHostId: 'server', accessTokenSecret: 'TOKEN' }, secret: () => 'x' });
    const request = await world.tools().find(tool => tool.name === 'solver_request_access').handler({ targetService: 'tts', purpose: 'speak' });
    assert.equal(request.spendable, false);
    assert.equal(request.failed, true);
    assert.match(request.text, /broker_not_configured/);
  } finally { globalThis.fetch = originalFetch; }
});

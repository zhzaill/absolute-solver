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
    'absolute-solver.environment',
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

test('visit tools request the fixed projection and expose structured current environment', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push([String(url), init]);
    if (String(url).endsWith('/projection/visit/request')) return new Response(JSON.stringify({ visit_id: 'v1', status: 'requesting', expires_at_ms: 5000 }), { status: 202 });
    if (String(url).endsWith('/projection/visit/return')) return new Response(JSON.stringify({ status: 'returning' }), { status: 200 });
    if (String(url).includes('/projection/visit/current?')) return new Response(JSON.stringify({ visit_id: 'v1', current_location: 'remote', projection_status: 'active', display_anchor: 'bottom', audio_output: 'remote', expires_at_ms: 5000, last_transition: 'browser_opened' }), { status: 200 });
    if (String(url).endsWith('/projection/host/state/server')) return new Response(JSON.stringify({ host_id: 'server', online: true, projection_capable: true, projection_status: 'active' }), { status: 200 });
    if (String(url).endsWith('/api/config') && !init.method) return new Response(JSON.stringify({ groups: [{ group: { id: 'world:audio-play' }, values: { 'worlds.audio-play.autoPlay': true } }] }), { status: 200 });
    if (String(url).endsWith('/api/config')) return new Response(JSON.stringify({ result: 'world:audio-play' }), { status: 200 });
    if (String(url).includes('/api/webui/providers/world%3Adesktop-pet/panels/pet/state')) return new Response(JSON.stringify({ onDesktop: true }), { status: 200 });
    if (String(url).includes('/api/webui/providers/world%3Adesktop-pet/panels/pet/hideWindow')) return new Response(JSON.stringify({ onDesktop: false }), { status: 200 });
    if (String(url).includes('/api/webui/providers/world%3Aaudio-play/panels/queue/clear')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    throw new Error(`unexpected ${url}`);
  };
  try {
    const world = new AbsoluteSolverWorld({ cfg: { projectionHubUrl: 'http://hub', projectionTargetHostId: 'server', projectionSourceInstance: 'coo-local', projectionTokenSecret: 'TOKEN' }, secret: () => 'secret' });
    const tools = world.tools();
    const requested = await tools.find(tool => tool.name === 'solver_request_visit').handler({ purpose: '用户要求串门' });
    assert.equal(requested.status, 'requesting');
    const requestBody = JSON.parse(calls[0][1].body);
    assert.equal(requestBody.projection_id, 'coo-pet');
    assert.equal(requestBody.display_anchor, 'bottom');
    assert.equal(requestBody.audio_mode, 'remote_active');
    assert.equal(requestBody.target_host_id, 'server');
    const environment = await tools.find(tool => tool.name === 'solver_environment').handler({});
    assert.equal(environment.current_location, 'remote');
    assert.equal(environment.audio_output, 'remote');
    assert.equal(environment.current_host_id, 'server');
    assert.equal(JSON.stringify(environment).includes('secret'), false);
    assert.equal(environment.local_output.hidden, true);
    assert.equal(environment.local_output.audioMuted, true);
    const returned = await tools.find(tool => tool.name === 'solver_return_visit').handler({ visitId: 'v1' });
    assert.equal(returned.status, 'returning');
    const returnCall = calls.find(([url]) => url.endsWith('/projection/visit/return'));
    assert.equal(JSON.parse(returnCall[1].body).source_instance, 'coo-local');
  } finally { globalThis.fetch = originalFetch; }
});

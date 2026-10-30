#!/usr/bin/env node
/**
 * Two-machine TTS acceptance rehearsal.
 *
 * Proves, in order and with real HTTP, that:
 *   1. a call with no approval is refused before any upstream traffic;
 *   2. one approval → exactly one forwarded call;
 *   3. the same approval cannot be spent twice;
 *   4. a revoked approval stops working immediately;
 *   5. the Hub record ties request → grant → consume → result together.
 *
 * It runs a local stand-in Hub and upstream so the whole chain can be exercised
 * without touching the production deployment, then reports what a real
 * two-machine run must additionally show (voice output and actual playback).
 */
import http from 'node:http';
import { createAccessAgent } from './access-agent.mjs';
import { createCooAccessBroker } from './coo-access-broker.mjs';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Minimal Hub with the same contract the real one implements. */
function createRehearsalHub() {
  const requests = new Map();
  const audit = [];
  let grants = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://hub');
    const body = await read(req);
    if (req.headers.authorization !== 'Bearer hub-token') return send(res, 401, { error: 'unauthorized' });

    if (url.pathname === '/access/request' && req.method === 'POST') {
      const input = JSON.parse(body || '{}');
      const outstanding = [...requests.values()].some(r =>
        r.source_instance === input.source_instance && r.target_host_id === input.target_host_id
        && r.target_service === input.target_service && ['pending', 'granted'].includes(r.status));
      if (outstanding) return send(res, 409, { error: 'access_busy' });
      if (requests.has(input.request_id)) return send(res, 409, { error: 'duplicate_request' });
      requests.set(input.request_id, { ...input, status: 'pending', expired: false });
      audit.push(`request ${input.request_id}`);
      return send(res, 202, { request_id: input.request_id, expires_at_ms: input.expires_at_ms, status: 'pending' });
    }
    if (url.pathname.startsWith('/access/state/')) {
      const id = decodeURIComponent(url.pathname.slice('/access/state/'.length));
      const request = requests.get(id);
      if (!request) return send(res, 404, { error: 'unknown_request' });
      if (request.status === 'pending' && Date.now() > request.expires_at_ms) request.status = 'expired';
      return send(res, 200, { request_id: id, ...request });
    }
    if (url.pathname === '/access/claim' && req.method === 'POST') {
      const input = JSON.parse(body || '{}');
      const ready = [...requests.entries()].filter(([, r]) =>
        r.source_instance === input.source_instance && r.target_host_id === input.target_host_id
        && r.target_service === input.target_service && r.operation === input.operation
        && r.status === 'granted');
      if (input.request_id !== undefined) {
        const entry = requests.get(input.request_id);
        if (!entry) return send(res, 409, { error: 'Unknown' });
        if (entry.source_instance !== input.source_instance || entry.target_host_id !== input.target_host_id
          || entry.target_service !== input.target_service || entry.operation !== input.operation) {
          return send(res, 409, { error: 'RouteMismatch' });
        }
        if (entry.status === 'consumed') return send(res, 409, { error: 'AlreadyConsumed' });
        if (entry.status !== 'granted') return send(res, 409, { error: 'NotGranted' });
        entry.status = 'consumed';
        audit.push(`claim ${input.request_id} (identified)`);
        return send(res, 200, { ...entry });
      }
      if (!ready.length) return send(res, 409, { error: 'NoMatchingGrant' });
      if (ready.length > 1) return send(res, 409, { error: 'AmbiguousGrant' });
      ready[0][1].status = 'consumed';
      audit.push(`claim ${ready[0][0]} (tuple)`);
      return send(res, 200, { ...ready[0][1] });
    }
    if (url.pathname === '/access/result' && req.method === 'POST') {
      const input = JSON.parse(body || '{}');
      const entry = requests.get(input.request_id);
      if (!entry) return send(res, 409, { error: 'Unknown' });
      if (entry.status !== 'consumed') return send(res, 409, { error: 'NotGranted' });
      entry.result_status = `http_${input.http_status}`;
      entry.elapsed_ms = input.elapsed_ms;
      audit.push(`result ${input.request_id} http_${input.http_status}`);
      return send(res, 202, { ok: true });
    }
    if (url.pathname === '/access/revoke' && req.method === 'POST') {
      const input = JSON.parse(body || '{}');
      const entry = requests.get(input.request_id);
      if (!entry) return send(res, 409, { error: 'Unknown' });
      if (!['pending', 'granted'].includes(entry.status)) return send(res, 409, { error: 'NotPending' });
      entry.status = 'revoked';
      audit.push(`revoke ${input.request_id}`);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not_found' });
  });
  return { server, requests, audit, approve: (id) => { const r = requests.get(id); if (r) r.status = 'granted'; } };
}

test_suite();

async function test_suite() {
  const hub = createRehearsalHub();
  await listen(hub.server);
  const hubUrl = `http://127.0.0.1:${hub.server.address().port}`;

  const upstreamCalls = [];
  const upstream = http.createServer(async (req, res) => {
    upstreamCalls.push(req.url);
    res.writeHead(200, { 'content-type': 'audio/wav' });
    res.end(Buffer.from('RIFF....WAVEfmt '));
  });
  await listen(upstream);
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  const agent = createAccessAgent({
    hubUrl, hubToken: 'hub-token', hostId: 'host-166',
    proxyToken: 'agent-token', ttsUpstream: upstreamUrl, asrUpstream: upstreamUrl,
  });
  await listen(agent);
  const agentUrl = `http://127.0.0.1:${agent.address().port}`;

  const broker = createCooAccessBroker({
    hubUrl, hubToken: 'hub-token', brokerToken: 'broker-token',
    agentToken: 'agent-token', agentUrl,
  });
  await listen(broker);
  const brokerUrl = `http://127.0.0.1:${broker.address().port}`;

  const speak = () => fetch(`${brokerUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: { authorization: 'Bearer broker-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', input: '验收短句', voice: 'xxx_trained' }),
  });

  try {
    // 1. No approval at all.
    let response = await speak();
    record('无许可时拒绝，且不触及上游', response.status === 403 && upstreamCalls.length === 0,
      `HTTP ${response.status}, upstream=${upstreamCalls.length}`);

    // 2. Create + register + approve, then spend exactly once.
    const requestId = 'coo-access-acceptance-1';
    const created = await fetch(`${hubUrl}/access/request`, {
      method: 'POST',
      headers: { authorization: 'Bearer hub-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: requestId, source_instance: 'cortico', target_host_id: 'host-166',
        target_service: 'tts', operation: 'speech.synthesize', purpose: '验收',
        ttl_ms: 30_000, expires_at_ms: Date.now() + 30_000,
      }),
    });
    record('Hub 受理一次请求', created.status === 202, `HTTP ${created.status}`);

    const registered = await fetch(`${brokerUrl}/solver/approvals`, {
      method: 'POST',
      headers: { authorization: 'Bearer broker-token', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, service: 'tts', hostId: 'host-166', expiresAtMs: Date.now() + 30_000 }),
    });
    record('适配层登记该许可', registered.status === 201, `HTTP ${registered.status}`);

    // Still pending on the target: nothing spendable yet.
    response = await speak();
    record('未获目标机允许前不可用', response.status === 403 && upstreamCalls.length === 0,
      `HTTP ${response.status}`);

    hub.approve(requestId);
    response = await speak();
    const body = Buffer.from(await response.arrayBuffer());
    record('允许后一次转发成功', response.status === 200 && upstreamCalls.length === 1,
      `HTTP ${response.status}, upstream=${upstreamCalls.length}, bytes=${body.length}`);
    record('响应带回许可关联', response.headers.get('x-solver-request-id') === requestId,
      `x-solver-request-id=${response.headers.get('x-solver-request-id')}`);

    // 3. Replay the same approval.
    response = await speak();
    record('同一许可不可二次消费', response.status === 403 && upstreamCalls.length === 1,
      `HTTP ${response.status}, upstream=${upstreamCalls.length}`);

    // 4. Single flight at Hub.
    await fetch(`${hubUrl}/access/request`, {
      method: 'POST', headers: { authorization: 'Bearer hub-token', 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: 'sf-1', source_instance: 'cortico', target_host_id: 'host-166', target_service: 'tts', operation: 'speech.synthesize', purpose: 'a', ttl_ms: 30_000, expires_at_ms: Date.now() + 30_000 }),
    });
    const busy = await fetch(`${hubUrl}/access/request`, {
      method: 'POST', headers: { authorization: 'Bearer hub-token', 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: 'sf-2', source_instance: 'cortico', target_host_id: 'host-166', target_service: 'tts', operation: 'speech.synthesize', purpose: 'b', ttl_ms: 30_000, expires_at_ms: Date.now() + 30_000 }),
    });
    record('同源同服务第二条请求被单飞拒绝', busy.status === 409, `HTTP ${busy.status}`);

    // 5. Revoked approval is dead.
    const revokeId = 'sf-1';
    await fetch(`${brokerUrl}/solver/approvals`, {
      method: 'POST', headers: { authorization: 'Bearer broker-token', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: revokeId, service: 'tts', hostId: 'host-166', expiresAtMs: Date.now() + 30_000 }),
    });
    await fetch(`${hubUrl}/access/revoke`, {
      method: 'POST', headers: { authorization: 'Bearer hub-token', 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: revokeId, reason: 'acceptance' }),
    });
    response = await speak();
    record('撤销后的许可不可用', response.status === 403 && upstreamCalls.length === 1,
      `HTTP ${response.status}`);

    // 6. Audit chain is complete.
    const chain = hub.audit.join(' | ');
    const complete = hub.audit.some(a => a.startsWith('request coo-access-acceptance-1'))
      && hub.audit.some(a => a.startsWith('claim coo-access-acceptance-1'))
      && hub.audit.some(a => a.startsWith('result coo-access-acceptance-1'));
    const result = hub.requests.get('coo-access-acceptance-1');
    record('请求→领取→回执可追溯', complete && result?.result_status === 'http_200',
      `result_status=${result?.result_status}; chain=${chain}`);

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (failed.length) process.exitCode = 1;
    else {
      console.log('\n仍未由本脚本覆盖，需真实双机确认：');
      console.log('  - Coo 插件真实合成出的音色（tts.voice 内容）');
      console.log('  - 目标机浏览器/扬声器的实际播放（audio-play）');
      console.log('  - 目标机本地确认面板的真人点击');
    }
  } finally {
    broker.close(); agent.close(); upstream.close(); hub.server.close();
  }
}

function send(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}
async function read(req) { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks).toString('utf8'); }
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }

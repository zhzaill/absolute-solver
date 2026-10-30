#!/usr/bin/env node
/**
 * Coo-side approval broker.
 *
 * Why this exists
 * ---------------
 * `cortico-world-tts@0.1.4` sends exactly two headers (`Content-Type`, and
 * `Authorization` when a key is configured). It has no field, setting or hook
 * that can carry our `request_id`. So a plugin call physically cannot say which
 * approval it is spending, and the target-side agent would be back to guessing
 * by tuple similarity.
 *
 * This broker sits where the plugin's `baseUrl` points. It is the component that
 * *creates* the approvals (the World tool registers them here the moment Hub
 * accepts `/access/request`), so the association is identity, not matching: the
 * request a call spends is the one this broker registered, addressed by its own
 * id and pinned to the route it was issued for.
 *
 * What it is not
 * --------------
 * It holds no grant token and makes no allow/deny decision. It never mints a
 * request id. Its only effects are: attach a header it already owns, forward the
 * fixed route, and mirror Hub truth back into its bookkeeping. If it does not
 * know an approval, it refuses instead of forwarding.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_BODY = 8 * 1024 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,96}$/;
const ROUTES = new Map([
  ['/v1/audio/speech', { service: 'tts', operation: 'speech.synthesize' }],
  ['/v1/audio/transcriptions', { service: 'asr', operation: 'audio.transcribe' }],
]);
/** Hub states after which an approval can never be spent again. */
const TERMINAL = new Set(['consumed', 'denied', 'revoked', 'expired', 'host_offline']);

function env(name, fallback = '') { return String(process.env[name] ?? fallback).trim(); }
function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) reject(new Error('request too large')); else chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Approvals this process is allowed to spend, keyed by the request id it was
 * given. Nothing is inferred: an entry exists only because someone holding the
 * broker token registered it.
 */
export class ApprovalRegistry {
  #entries = new Map();

  register({ requestId, service, hostId, expiresAtMs }) {
    if (!REQUEST_ID_PATTERN.test(String(requestId ?? ''))) throw new Error('invalid_request_id');
    if (service !== 'tts' && service !== 'asr') throw new Error('invalid_service');
    if (!String(hostId ?? '').trim()) throw new Error('invalid_host');
    if (this.#entries.has(requestId)) throw new Error('duplicate_approval');
    this.#entries.set(requestId, {
      requestId,
      service,
      hostId: String(hostId),
      expiresAtMs: Number(expiresAtMs) || 0,
      status: 'ready',
    });
    return this.#entries.get(requestId);
  }

  /** The single ready approval for a service, or null. Two ready is a bug, not a choice. */
  take(service, nowMs) {
    const ready = [...this.#entries.values()].filter(entry =>
      entry.service === service && entry.status === 'ready'
      && (!entry.expiresAtMs || entry.expiresAtMs > nowMs));
    if (ready.length !== 1) return null;
    const [entry] = ready;
    entry.status = 'in-flight';
    return entry;
  }

  /** Mirror Hub truth. A terminal state drops the entry; anything else frees it for retry. */
  settle(requestId, hubStatus) {
    const entry = this.#entries.get(requestId);
    if (!entry) return;
    const status = String(hubStatus ?? '');
    if (TERMINAL.has(status)) this.#entries.delete(requestId);
    else if (entry.status === 'in-flight') entry.status = 'ready';
  }

  release(requestId) {
    const entry = this.#entries.get(requestId);
    if (entry && entry.status === 'in-flight') entry.status = 'ready';
  }

  snapshot(nowMs = Date.now()) {
    return [...this.#entries.values()].map(entry => ({
      requestId: entry.requestId,
      service: entry.service,
      hostId: entry.hostId,
      status: entry.status,
      expiresAtMs: entry.expiresAtMs,
      expired: Boolean(entry.expiresAtMs && entry.expiresAtMs <= nowMs),
    }));
  }
}

async function hubState({ hubUrl, token, requestId, fetchImpl }) {
  const response = await fetchImpl(`${hubUrl}/access/state/${encodeURIComponent(requestId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  return body && typeof body.status === 'string' ? body.status : null;
}

export function createCooAccessBroker(options = {}) {
  const agentUrl = String(options.agentUrl || env('SOLVER_AGENT_URL', 'http://127.0.0.1:18082')).replace(/\/$/, '');
  const hubUrl = String(options.hubUrl || env('SOLVER_HUB_HTTP', 'http://127.0.0.1:18100')).replace(/\/$/, '');
  const hubToken = String(options.hubToken || env('SOLVER_PRESENCE_TOKEN'));
  const brokerToken = String(options.brokerToken || env('SOLVER_BROKER_TOKEN'));
  const agentToken = String(options.agentToken || env('SOLVER_AGENT_TOKEN'));
  const fetchImpl = options.fetchImpl || fetch;
  const registry = options.registry || new ApprovalRegistry();
  const now = options.now || Date.now;
  if (!hubToken || !brokerToken || !agentToken) {
    throw new Error('SOLVER_PRESENCE_TOKEN, SOLVER_BROKER_TOKEN and SOLVER_AGENT_TOKEN are required');
  }

  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://broker').pathname;
    if (req.headers.authorization !== `Bearer ${brokerToken}`) return json(res, 401, { error: 'unauthorized' });

    // Registration is the only way an approval becomes spendable here.
    if (pathname === '/solver/approvals' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const entry = registry.register(body);
        return json(res, 201, { requestId: entry.requestId, service: entry.service, status: entry.status });
      } catch (error) {
        return json(res, 400, { error: String(error.message).slice(0, 120) });
      }
    }
    if (pathname === '/solver/approvals' && req.method === 'GET') {
      return json(res, 200, { approvals: registry.snapshot(now()) });
    }

    const route = ROUTES.get(pathname);
    if (req.method !== 'POST' || !route) return json(res, 404, { error: 'fixed_tts_asr_routes_only' });

    const entry = registry.take(route.service, now());
    if (!entry) return json(res, 403, { error: 'no_approved_request' });

    try {
      const body = await readBody(req);
      const headers = { 'content-type': req.headers['content-type'] || 'application/json' };
      // The identity of the approval travels as data, so the agent checks it
      // instead of searching for a plausible match.
      headers.authorization = `Bearer ${agentToken}`;
      headers['x-solver-request-id'] = entry.requestId;
      const response = await fetchImpl(`${agentUrl}${pathname}`, { method: 'POST', headers, body });
      const output = Buffer.from(await response.arrayBuffer());

      // Never assume what happened: read the Hub's own record and mirror it.
      const status = await hubState({ hubUrl, token: hubToken, requestId: entry.requestId, fetchImpl }).catch(() => null);
      if (status) registry.settle(entry.requestId, status);
      else if (response.ok) registry.release(entry.requestId);

      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') || 'application/octet-stream',
        'content-length': output.length,
        'x-solver-request-id': entry.requestId,
        'x-solver-access-state': status || 'unknown',
      });
      res.end(output);
    } catch (error) {
      registry.release(entry.requestId);
      json(res, 502, { error: String(error.message).slice(0, 240) });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(env('SOLVER_BROKER_PORT', '18081'));
  createCooAccessBroker().listen(port, env('SOLVER_BROKER_HOST', '127.0.0.1'), () =>
    console.log(`Absolute Solver Coo approval broker listening on ${port}`));
}

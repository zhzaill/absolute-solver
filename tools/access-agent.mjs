#!/usr/bin/env node
/**
 * Fixed TTS/ASR access adapter for a trusted Host.
 * It is intentionally an OpenAI-compatible edge: no arbitrary proxy, URL or shell.
 * The caller must have an already approved request; this process never creates one.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_BODY = 8 * 1024 * 1024;
const allowed = new Map([
  ['/v1/audio/speech', { service: 'tts', operation: 'speech.synthesize', contentType: 'json' }],
  ['/v1/audio/transcriptions', { service: 'asr', operation: 'audio.transcribe', contentType: 'multipart' }],
]);

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
function auth(req) {
  const expected = env('SOLVER_AGENT_TOKEN');
  if (!expected) return false;
  return req.headers.authorization === `Bearer ${expected}`;
}
async function hubJson(url, token, init) {
  const response = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init?.headers || {}) } });
  const body = await response.text();
  let value; try { value = body ? JSON.parse(body) : {}; } catch { value = { error: body.slice(0, 200) }; }
  if (!response.ok) throw new Error(`Hub HTTP ${response.status}: ${value.error || 'request failed'}`);
  return value;
}

// The plugin may carry the approval it was handed. When it does, the agent only
// spends that exact request; it never invents one and never widens the search.
const REQUEST_ID_HEADER = 'x-solver-request-id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,96}$/;

function carriedRequestId(req) {
  const raw = req.headers[REQUEST_ID_HEADER];
  if (raw === undefined) return undefined;
  const value = String(Array.isArray(raw) ? '' : raw).trim();
  return REQUEST_ID_PATTERN.test(value) ? value : null;
}

async function claimAccess({ hubUrl, token, hostId, service, operation, source, requestId }) {
  const claim = await hubJson(`${hubUrl}/access/claim`, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(requestId ? { request_id: requestId } : {}),
      source_instance: source,
      target_host_id: hostId,
      target_service: service,
      operation,
    }),
  });
  if (claim.status !== 'consumed' || claim.source_instance !== source
      || claim.target_host_id !== hostId || claim.target_service !== service
      || claim.operation !== operation || !REQUEST_ID_PATTERN.test(claim.request_id || '')
      || (requestId && claim.request_id !== requestId)) {
    throw new Error('access claim did not match the fixed route');
  }
  return claim;
}

export function createAccessAgent(options = {}) {
  const hubUrl = String(options.hubUrl || env('SOLVER_HUB_HTTP', 'http://127.0.0.1:18100')).replace(/\/$/, '');
  const hubToken = String(options.hubToken || env('SOLVER_PRESENCE_TOKEN'));
  const hostId = String(options.hostId || env('SOLVER_HOST_ID'));
  const ttsUpstream = String(options.ttsUpstream || env('SOLVER_TTS_UPSTREAM', 'http://127.0.0.1:18080')).replace(/\/$/, '');
  const asrUpstream = String(options.asrUpstream || env('SOLVER_ASR_UPSTREAM', 'http://127.0.0.1:9881')).replace(/\/$/, '');
  const fetchImpl = options.fetchImpl || fetch;
  if (!hubToken || !hostId || !env('SOLVER_AGENT_TOKEN') && !options.proxyToken) throw new Error('SOLVER_PRESENCE_TOKEN, SOLVER_HOST_ID and SOLVER_AGENT_TOKEN are required');
  const proxyToken = options.proxyToken || env('SOLVER_AGENT_TOKEN');
  return http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${proxyToken}`) return json(res, 401, { error: 'unauthorized' });
    const route = allowed.get(req.url?.split('?')[0]);
    if (req.method !== 'POST' || !route) return json(res, 404, { error: 'fixed_tts_asr_routes_only' });
    let requestId = '';
    const startedAt = Date.now();
    try {
      const carried = carriedRequestId(req);
      if (carried === null) return json(res, 400, { error: 'invalid_request_id_header' });
      const body = await readBody(req);
      const source = String(options.sourceInstance || env('SOLVER_SOURCE_INSTANCE', 'cortico')).slice(0, 96);
      const claim = await claimAccess({ hubUrl, token: hubToken, hostId, service: route.service, operation: route.operation, source, requestId: carried });
      requestId = claim.request_id;
      const upstream = route.service === 'tts' ? ttsUpstream : asrUpstream;
      const headers = {};
      if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
      const upstreamKey = route.service === 'tts' ? env('SOLVER_TTS_API_KEY') : env('SOLVER_ASR_API_KEY');
      if (upstreamKey) headers.authorization = `Bearer ${upstreamKey}`;
      let response;
      let output;
      try {
        response = await fetchImpl(`${upstream}${req.url?.split('?')[0]}`, { method: 'POST', headers, body });
        output = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        await reportResult({ hubUrl, hubToken, requestId, hostId, httpStatus: 502, elapsedMs: Date.now() - startedAt });
        throw error;
      }
      await reportResult({ hubUrl, hubToken, requestId, hostId, httpStatus: response.status, elapsedMs: Date.now() - startedAt });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/octet-stream', 'content-length': output.length });
      res.end(output);
    } catch (error) {
      json(res, /timed out|access |Hub HTTP 409/.test(String(error.message)) ? 403 : 502, { error: String(error.message).slice(0, 240) });
    }
  });
}

function reportResult({ hubUrl, hubToken, requestId, hostId, httpStatus, elapsedMs }) {
  return hubJson(`${hubUrl}/access/result`, hubToken, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: requestId, target_host_id: hostId, http_status: httpStatus, elapsed_ms: elapsedMs }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(env('SOLVER_AGENT_PORT', '18082'));
  createAccessAgent().listen(port, env('SOLVER_AGENT_HOST', '127.0.0.1'), () => console.log(`Absolute Solver access agent listening on ${port}`));
}

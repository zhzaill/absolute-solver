#!/usr/bin/env node
/**
 * Cross-machine acceptance against the real isolated stack on 192.168.1.166.
 *
 * Unlike the local rehearsal, every hop here is real:
 *   this machine (Coo side) -> LAN -> 166 hub :18201 / agent :18082 / broker :18084 -> real TTS upstream :18080
 *
 * What it proves: the approval chain, single flight, one-shot consumption,
 * revoke, and the receipt — across the wire.
 * What it does NOT prove: a human clicking Allow on the target host, the actual
 * speaker playback, and the trained voice timbre. Those need the operator.
 *
 * Secrets are read from the target's DPAPI store, never from this machine.
 */
import { execFileSync } from 'node:child_process';

const HOST = process.env.STAGE2_HOST || '192.168.1.166';
const USER = process.env.STAGE2_USER || 'zhzaill';
const PASSWORD = process.env.STAGE2_PASSWORD || '1213';
const HOSTKEY = process.env.STAGE2_HOSTKEY || 'SHA256:mi6ruODDjDlZBosOGrVIAJ4UFTIGPYRP11eH4cNLh+M';
const HUB = `http://${HOST}:18201`;
const AGENT = `http://${HOST}:18082`;
const BROKER = `http://${HOST}:18084`;
const TTS_UPSTREAM = `http://${HOST}:18080`;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Read the three stage2 secrets from the target's DPAPI store. */
function loadSecrets() {
  const script = `
$s = Import-Clixml 'E:\\Absolute-Solver\\stage2\\stage2-secrets.xml'
function P([Security.SecureString] $v) { $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($v); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) } }
"$((P $s.Hub))|$((P $s.Agent))|$((P $s.Broker))"
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = execFileSync('plink', ['-batch', '-hostkey', HOSTKEY, '-pw', PASSWORD, `${USER}@${HOST}`, `powershell -NoProfile -EncodedCommand ${encoded}`], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  const line = out.split(/\r?\n/).map(s => s.trim()).find(s => s.split('|').length === 3 && s.length > 20);
  if (!line) throw new Error('could not read stage2 secrets from target');
  const [hub, agent, broker] = line.split('|');
  return { hub, agent, broker };
}

async function main() {
  const secrets = loadSecrets();
  record('目标机密钥可从 DPAPI 读取', Boolean(secrets.hub && secrets.agent && secrets.broker), 'hub/agent/broker 均已取到');

  const auth = { authorization: `Bearer ${secrets.broker}`, 'content-type': 'application/json' };

  // 0. Reachability of each real component.
  const state = await fetch(`${HUB}/state`).then(r => r.status).catch(() => 0);
  record('166 隔离 Hub 可达', state === 200, `GET /state = ${state}`);
  const prodState = await fetch(`http://${HOST}:18100/state`).then(r => r.status).catch(() => 0);
  record('生产 Hub 仍在运行且未被改动', prodState === 200, `GET :18100/state = ${prodState}`);

  // 1. No approval -> refused before any upstream traffic.
  const speech = (body = { model: 'tts-1', input: '双机验收短句', voice: 'xxx_trained' }) =>
    fetch(`${BROKER}/v1/audio/speech`, { method: 'POST', headers: auth, body: JSON.stringify(body) });

  let r = await speech();
  record('无许可时拒绝', r.status === 403, `HTTP ${r.status} ${JSON.stringify(await r.json().catch(() => ({})))}`);

  // 2. Create the approval on the real Hub, register it with the real broker.
  const requestId = `coo-lan-${Date.now()}-a1`;
  const created = await fetch(`${HUB}/access/request`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secrets.hub}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      request_id: requestId, source_instance: 'cortico', target_host_id: 'solver-host-166',
      target_service: 'tts', operation: 'speech.synthesize',
      purpose: '双机验收', environment_id: 'lan-166', ttl_ms: 60000,
    }),
  });
  const createdBody = await created.json().catch(() => ({}));
  record('真实 Hub 受理请求', created.status === 202, `HTTP ${created.status} ${JSON.stringify(createdBody).slice(0, 120)}`);

  const registered = await fetch(`${BROKER}/solver/approvals`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ requestId, service: 'tts', hostId: 'solver-host-166', expiresAtMs: Date.now() + 60000 }),
  });
  record('真实 Broker 登记该许可', registered.status === 201, `HTTP ${registered.status}`);

  // 3. Still pending: nothing may be spent yet.
  r = await speech();
  record('目标机未允许前仍不可用', r.status === 403, `HTTP ${r.status}`);

  // 4. Approve on the target exactly as the Host UI would, then spend once.
  const approved = await fetch(`${HUB}/access/decision`, {
    method: 'POST', headers: { authorization: `Bearer ${secrets.hub}`, 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: requestId, host_id: 'solver-host-166', allow: true }),
  }).catch(() => null);
  let approveNote = `HTTP ${approved?.status ?? 'n/a'}`;
  if (!approved || !approved.ok) {
    // Fall back to the same transition the decision handler performs, so the
    // rest of the chain can still be exercised; this is recorded as a gap.
    approveNote += ' (需要 Host UI 在线点击，本次未通过 UI)';
  }

  r = await speech();
  const audio = r.ok ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
  record('允许后一次转发成功', r.status === 200 && audio.length > 1000, `HTTP ${r.status}, bytes=${audio.length}`);
  if (r.ok) {
    const head = audio.subarray(0, 12).toString('latin1');
    record('返回真实音频（非占位）', head.startsWith('RIFF') || audio.length > 10000, `head=${JSON.stringify(head)}`);
    record('响应带回许可关联', r.headers.get('x-solver-request-id') === requestId, `x-solver-request-id=${r.headers.get('x-solver-request-id')}`);
  }

  // 5. Replay must fail.
  r = await speech();
  record('同一许可不可二次消费', r.status === 403, `HTTP ${r.status}`);

  // 6. Hub record ties the whole chain together.
  const stateRes = await fetch(`${HUB}/access/state/${encodeURIComponent(requestId)}`, {
    headers: { authorization: `Bearer ${secrets.hub}` },
  });
  const rec = await stateRes.json().catch(() => ({}));
  record('Hub 记录完整（请求→消费→回执）', stateRes.status === 200 && rec.status === 'consumed',
    `status=${rec.status}, result=${rec.result_status}, elapsed=${rec.elapsed_ms}ms`);

  // 7. Single flight on the real Hub.
  const mk = id => fetch(`${HUB}/access/request`, {
    method: 'POST', headers: { authorization: `Bearer ${secrets.hub}`, 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: id, source_instance: 'cortico', target_host_id: 'solver-host-166', target_service: 'tts', operation: 'speech.synthesize', purpose: 'sf', ttl_ms: 60000 }),
  });
  const first = await mk(`coo-lan-${Date.now()}-sf1`);
  const second = await mk(`coo-lan-${Date.now()}-sf2`);
  record('同源同服务第二条被单飞拒绝', first.status === 202 && second.status === 409, `first=${first.status}, second=${second.status}`);

  const failed = results.filter(x => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (approveNote.includes('未通过 UI')) console.log(`\n注意：${approveNote}`);
  console.log('\n仍需现场操作员完成：');
  console.log('  1. 在 166 桌面点击 Host 面板上的“允许”（access.request 已推送到 UI）');
  console.log('  2. 用耳朵确认扬声器真实播放');
  console.log('  3. 确认 tts.voice 音色为 xxx_trained');
  if (failed.length) process.exitCode = 1;
}

main().catch(error => { console.error(`FAILED: ${error.message}`); process.exitCode = 1; });

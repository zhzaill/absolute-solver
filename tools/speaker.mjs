#!/usr/bin/env node
// Speaker activator: keep the TTS gateway + upstream resident while using
// Cortico; sleep them to free the GPU for other model testing. Both are held
// by long-lived SSH sessions (as the SSH user) because the SYSTEM scheduled
// task stalls on this host before it binds a port.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cfgPath = resolve(here, 'host-projection.local.json');
let cfg = {};
try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch {}
const dev = cfg.device || {};
const HOST = process.env.SPEAKER_HOST || dev.host || '192.168.67.166';
const USER = process.env.SPEAKER_USER || dev.user || 'zhzaill';
const KEY = process.env.SPEAKER_KEY || dev.identityFile || 'C:/Users/zhzaill/.ssh/id_loopros';
const BASE = process.env.SPEAKER_BASE || 'E:\\GPT-SoVITS\\GPT-SoVITS-v2pro-20250604-nvidia50';
const GATEWAY_DIR = process.env.SPEAKER_GATEWAY_DIR || 'E:\\GPT-SoVITS\\gateway';
const SSH_ARGS = ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
const GATEWAY = `http://${HOST}:18080/healthz`;
const STATE = resolve(here, '.speaker-state.json');

const ssh = (remote) => spawnSync('ssh', [...SSH_ARGS, `${USER}@${HOST}`, remote], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    if (s.pid && !s.upstreamPid) s.upstreamPid = s.pid;
    return s;
  } catch { return {}; }
}

function saveState(patch) {
  const state = { ...loadState(), ...patch };
  writeFileSync(STATE, JSON.stringify(state));
  return state;
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function hold(remote) {
  const child = spawn('ssh', [...SSH_ARGS, `${USER}@${HOST}`, remote], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}

async function health() {
  try {
    const r = await fetch(GATEWAY, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { ok: false, status: r.status };
    return await r.json();
  } catch (e) { return { ok: false, error: e.message }; }
}

function upstreamPids() {
  const ps = '$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "api_v2\\.py" } | Select-Object -ExpandProperty ProcessId; if ($p) { $p -join "," }';
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');
  const out = ssh(`powershell -NoProfile -EncodedCommand ${b64}`);
  return (out.stdout || '').trim().split(',').filter(Boolean).map(Number);
}

// The gateway is a FastAPI app whose imports take ~20 s on this host; the
// scheduled task that used to start it hangs before binding, so hold it over
// SSH exactly like the upstream.
async function ensureGateway() {
  let h = await health();
  if (h.ok) return h;
  const state = loadState();
  if (!alive(state.gatewayPid)) {
    const remote = `cmd /c "cd /d ${GATEWAY_DIR} && ${BASE}\\runtime\\python.exe -u gateway.py"`;
    const pid = hold(remote);
    saveState({ gatewayPid: pid, gatewaySince: Date.now() });
    console.log(`gateway starting via ssh pid ${pid}; slow imports, ~30-60s...`);
  } else {
    console.log(`gateway process ${state.gatewayPid} still alive; waiting for it to answer...`);
  }
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    h = await health();
    if (h.ok) { console.log('gateway: ok'); return h; }
    if (i % 5 === 4) console.log(`waiting for gateway... ${(i + 1) * 3}s`);
  }
  return h;
}

async function on() {
  const h = await ensureGateway();
  if (!h.ok) { console.log('gateway still not answering; aborting before upstream'); return report(); }
  const state = loadState();
  if (state.upstreamPid && upstreamPids().length) {
    console.log(`upstream already running (ssh pid ${state.upstreamPid})`);
    return report();
  }
  const remote = `cmd /c "cd /d ${BASE} && runtime\\python.exe -u api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS\\configs\\tts_infer.yaml"`;
  const pid = hold(remote);
  saveState({ upstreamPid: pid, upstreamSince: Date.now() });
  console.log(`upstream starting via ssh pid ${pid}; loading model (~2-3 min)...`);
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    const hh = await health();
    if (hh.upstream_alive) { console.log('upstream_alive: true'); return report(); }
    if (i % 5 === 4) console.log(`waiting... ${(i + 1) * 3}s`);
  }
  console.log('still not ready; check logs / gateway status');
}

async function off() {
  const state = loadState();
  if (state.upstreamPid) { try { process.kill(state.upstreamPid); } catch {} }
  // make sure the remote python is gone too
  const ps = '$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "api_v2\\.py" }; foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }; "killed " + $p.Count';
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');
  ssh(`powershell -NoProfile -EncodedCommand ${b64}`);
  saveState({ upstreamPid: null });
  console.log('upstream stopped; GPU freed');
}

async function report() {
  const h = await health();
  const state = loadState();
  console.log(JSON.stringify({
    gateway: h.ok ? 'ok' : 'down',
    upstream: h.ok && h.upstream_alive ? 'alive' : 'down',
    ssh: { gatewayPid: state.gatewayPid || null, upstreamPid: state.upstreamPid || null },
    upstreamProcesses: upstreamPids(),
    health: h,
  }, null, 1));
}

const cmd = process.argv[2] || 'status';
if (cmd === 'on' || cmd === 'start') await on();
else if (cmd === 'off' || cmd === 'sleep' || cmd === 'stop') await off();
else if (cmd === 'status') await report();
else console.log('usage: node tools/speaker.mjs on|sleep|status');

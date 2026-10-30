#!/usr/bin/env node
/**
 * Stage 3 protocol rehearsal only. This is not a real desktop approval:
 * it stands in for the target Host UI when no interactive server session is
 * available, and therefore cannot prove a browser window or speaker output.
 */
import { WebSocket } from 'ws';

const HUB_WS = process.env.STAGE3_HUB_WS || 'ws://192.168.1.166:18201/ws';
const HOST_ID = process.env.STAGE3_HOST_ID || 'solver-host-166';
const DECISION = (process.env.STAGE3_DECISION || 'allow').toLowerCase();
const TIMEOUT_MS = Number(process.env.STAGE3_TIMEOUT_MS || 45000);
const seen = [];
const ws = new WebSocket(HUB_WS);

ws.on('open', () => {
  console.log(`connected as ${HOST_ID} to ${HUB_WS} (projection decision=${DECISION})`);
  ws.send(JSON.stringify({
    v: 1,
    type: 'hello',
    device_id: HOST_ID,
    caps: { host_presence: true, host_access: true, projection_host: true, entry: 'body', ui: 'stage3-standin' },
  }));
});

ws.on('message', raw => {
  let message;
  try { message = JSON.parse(String(raw)); } catch { return; }
  if (message.type !== 'projection.visit.request') return;
  seen.push(message.visit_id);
  console.log(`projection.visit.request id=${message.visit_id} target=${message.target_host_id} purpose=${JSON.stringify(message.purpose)}`);
  if (message.target_host_id !== HOST_ID) return;
  const allow = DECISION === 'allow';
  ws.send(JSON.stringify({ v: 1, type: 'projection.visit.decision', visit_id: message.visit_id, host_id: HOST_ID, allow }));
  console.log(`  -> ${allow ? 'ALLOW' : 'DENY'} (stand-in; no desktop window)`);
  if (!allow) return;
  // A headless stand-in cannot open the fixed browser projection. Report the
  // fact explicitly so the Hub exercises failure/recovery rather than
  // pretending that an active remote desktop exists.
  setTimeout(() => ws.send(JSON.stringify({
    v: 1,
    type: 'projection.visit.state',
    visit_id: message.visit_id,
    host_id: HOST_ID,
    source_instance: message.source_instance,
    target_host_id: HOST_ID,
    status: 'failed',
    current_location: 'local',
    display_anchor: message.display_anchor,
    audio_output: 'local',
    last_transition: 'standin_no_interactive_desktop',
  })), 100);
});

ws.on('error', error => { console.error(`ws error: ${error.message}`); process.exitCode = 1; });
ws.on('close', () => console.log('closed'));
setTimeout(() => {
  console.log(`observed ${seen.length} projection request(s)`);
  ws.close();
}, TIMEOUT_MS);

#!/usr/bin/env node
/**
 * Stand-in for the human at the target machine.
 *
 * The Hub only accepts `access.decision` from the WebSocket connection that is
 * registered as that host (`handle_access_decision` rejects anything else). That
 * is the structural reason a request from another machine cannot approve itself.
 *
 * This helper connects as `solver-host-166`, prints every `access.request` the
 * Hub pushes (exactly what the Host UI panel shows), and answers with
 * `access.decision`. It is for acceptance runs where no operator is sitting at
 * the console; a real acceptance must also have a person click the panel.
 *
 * It refuses to approve anything not addressed to its own host id, so it cannot
 * be used to widen scope.
 */
import { WebSocket } from 'ws';

const HUB_WS = process.env.STAGE2_HUB_WS || 'ws://192.168.1.166:18201/ws';
const HOST_ID = process.env.STAGE2_HOST_ID || 'solver-host-166';
const DECISION = (process.env.STAGE2_DECISION || 'allow').toLowerCase();
const ONLY = process.env.STAGE2_ONLY_REQUEST || '';
const TIMEOUT_MS = Number(process.env.STAGE2_TIMEOUT_MS || 120000);

const seen = [];
const ws = new WebSocket(HUB_WS);

ws.on('open', () => {
  console.log(`connected as ${HOST_ID} to ${HUB_WS} (decision=${DECISION})`);
  // `host_access` must be declared or the Hub refuses to issue an access
  // request to this host (`host_access_unsupported`). The real Host UI declares
  // the same three flags in desktop/tauri-host/ui/main.js.
  ws.send(JSON.stringify({
    type: 'hello',
    device_id: HOST_ID,
    caps: { host_presence: true, host_access: true, projection_host: true, entry: 'body', ui: 'acceptance-standin' },
  }));
});

ws.on('message', raw => {
  let message;
  try { message = JSON.parse(String(raw)); } catch { return; }

  if (message.type === 'access.request') {
    const { request_id: requestId, target_host_id: target, purpose, target_service: service, expires_at_ms: expires } = message;
    seen.push({ requestId, target, service, purpose });
    console.log(`access.request id=${requestId} target=${target} service=${service} purpose=${JSON.stringify(purpose)} expires=${expires}`);

    if (target !== HOST_ID) {
      console.log(`  -> ignored: not addressed to ${HOST_ID}`);
      return;
    }
    if (ONLY && requestId !== ONLY) {
      console.log(`  -> ignored: not the selected request (${ONLY})`);
      return;
    }
    const allow = DECISION === 'allow';
    // A real operator reads the purpose and decides. Nothing here infers intent.
    console.log(`  -> ${allow ? 'ALLOW' : 'DENY'} (as the target host would)`);
    ws.send(JSON.stringify({ type: 'access.decision', request_id: requestId, host_id: HOST_ID, allow }));
  } else if (message.type === 'access.grant' || message.type === 'access.revoke') {
    console.log(`${message.type} id=${message.request_id} ${message.allow === undefined ? '' : `allow=${message.allow}`}`);
  } else if (message.type === 'body.handoff') {
    console.log(`body.handoff active=${message.active} reason=${message.reason}`);
  }
});

ws.on('error', error => { console.error(`ws error: ${error.message}`); process.exitCode = 1; });
ws.on('close', () => console.log('closed'));

setTimeout(() => {
  console.log(`\nobserved ${seen.length} request(s)`);
  ws.close();
  process.exit(seen.length ? 0 : 1);
}, TIMEOUT_MS);

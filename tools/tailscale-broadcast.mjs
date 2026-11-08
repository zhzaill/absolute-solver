#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const localConfigPath = `${root}/host-projection.local.json`;
const configPath = resolve(process.env.SOLVER_PROJECTION_CONFIG || (existsSync(localConfigPath) ? localConfigPath : `${root}/host-projection.example.json`));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const port = Number(process.env.SOLVER_PROJECTION_PORT || config.listenPort || 18111);

function tailscale(args) {
  return execFileSync('tailscale', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function dnsName() {
  try {
    return String(JSON.parse(tailscale(['status', '--json'])).Self?.DNSName || '').replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

const arg = process.argv[2] || '';

if (arg === '--status') {
  console.log(tailscale(['serve', 'status']));
} else if (arg === '--reset') {
  tailscale(['serve', 'reset']);
  console.log('tailscale serve reset');
} else {
  console.log(tailscale(['serve', '--bg', String(port)]));
  const name = dnsName();
  if (name) console.log(`\nBroadcast: https://${name}/  ->  http://127.0.0.1:${port}`);
}

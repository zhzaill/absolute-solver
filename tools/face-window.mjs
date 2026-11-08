#!/usr/bin/env node
// Launches the desktop-pet window: transparent, frameless, always-on-top, and
// click-through until you press Ctrl+Shift+F. It simply hosts /figure, so the
// character keeps using the same HTTPS/SSE bridge as the web projection.
//
//   node tools/face-window.mjs [--url http://127.0.0.1:18111/figure] [--size 420x760]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, 'face-window');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};

const url = arg('url', process.env.FACE_URL || 'http://127.0.0.1:18111/figure');
const size = arg('size', `${process.env.FACE_WIDTH || 420}x${process.env.FACE_HEIGHT || 760}`).split('x').map(Number);

const require = createRequire(import.meta.url);
let electronPath = null;
try { electronPath = require(resolve(appDir, 'node_modules', 'electron')); } catch { /* not installed */ }
if (!electronPath || !existsSync(electronPath)) {
  console.error('electron is not installed. Run:');
  console.error(`  cd "${appDir}" && npm install --no-audit --no-fund`);
  process.exit(2);
}

const env = { ...process.env, FACE_URL: url, FACE_WIDTH: String(size[0] || 420), FACE_HEIGHT: String(size[1] || 760) };
// Some terminals/agent shells set ELECTRON_RUN_AS_NODE, which turns the binary
// back into plain Node and leaves `require('electron').app` undefined.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [appDir], { stdio: 'inherit', windowsHide: false, env });
child.on('exit', (code) => process.exit(code ?? 0));

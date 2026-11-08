#!/usr/bin/env node
// Copies the Coo Live2D figure pack and the pet kit into tools/face/live2d so the
// face window renders from this project instead of reaching into the Coo install.
// Idempotent: re-run after the Coo pack changes. Big model assets stay gitignored.
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dstRoot = resolve(here, 'face/live2d');

const COO = process.env.COO_HOME || 'D:/11/Tools/coo';
const SOURCES = [
  {
    label: 'pack',
    from: resolve(COO, 'data/home/companion/data/figures/deepseek'),
    to: join(dstRoot, 'pack'),
    skip: [
      // 22 MB base64 fallback; the runtime fetches model.moc3 first over HTTPS.
      'models/deepseek/moc3.js',
      // Coo-specific native library index, not used by the live2d backend.
      'native-library.json',
      'thumb',
    ],
  },
  {
    label: 'kit',
    from: resolve(COO, 'resources/app/node_modules/cortico-world-desktop-pet/web/kit'),
    to: join(dstRoot, 'kit'),
    skip: [],
  },
  {
    // Model importer: turns a raw Cubism model folder into a pack this page can load.
    label: 'import',
    from: resolve(COO, 'data/extensions/node_modules/cortico-world-figure/workbench/tools'),
    to: resolve(here, 'face/import'),
    skip: ['workbench', 'native-catalog.mjs', 'shrink-textures.py'],
  },
];

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

let failed = false;
for (const source of SOURCES) {
  if (!(await exists(source.from))) {
    console.error(`[skip] ${source.label}: source missing -> ${source.from}`);
    failed = true;
    continue;
  }
  await rm(source.to, { recursive: true, force: true });
  await mkdir(source.to, { recursive: true });
  await cp(source.from, source.to, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(source.from.length + 1).replaceAll('\\', '/');
      return !source.skip.some((skip) => rel === skip || rel.startsWith(`${skip}/`));
    },
  });
  console.log(`[ok] ${source.label}: ${source.from} -> ${source.to}`);
}

const required = [
  'pack/figure.js',
  'pack/backends/live2d.js',
  'pack/sdk/live2dcubismcore.min.js',
  'pack/models/index.js',
  'pack/models/deepseek/model.moc3',
  'pack/models/deepseek/profile.js',
  'pack/models/deepseek/textures/texture_00.png',
  'kit/body.js',
  'kit/rig.js',
];
for (const rel of required) {
  if (!existsSync(join(dstRoot, rel))) {
    console.error(`[missing] ${rel}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`face assets ready at ${dstRoot}`);

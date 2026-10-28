import test from 'node:test';
import assert from 'node:assert/strict';
import { AbsoluteSolverWorld } from '../src/world.js';

test('invalid directory URLs do not become fetch targets', async () => {
  const world = new AbsoluteSolverWorld({ cfg: { directoryUrl: 'javascript:alert(1)' } });
  const result = await world.readServices();
  assert.equal(result.failed, true);
  assert.match(result.text, /地址无效/);
});

test('world exposes a read-only service tool and summarizes the directory', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    checkedAt: '2026-10-28T00:00:00.000Z',
    host: { address: '192.168.1.178' },
    services: [{ id: 'tts', name: 'TTS', type: 'tts', status: 'online', host: { name: 'Solver Host' }, capabilities: ['speech-synthesis'], version: 'unknown' }],
  }), { status: 200 });
  try {
    const world = new AbsoluteSolverWorld({ cfg: { directoryUrl: 'http://192.168.1.178:18110' } });
    const tool = world.tools()[0];
    const result = await tool.handler({});
    assert.equal(result.failed, undefined);
    assert.match(result.text, /speech-synthesis/);
    assert.equal(world.envPromptVars()['absolute-solver.directoryUrl'], 'http://192.168.1.178:18110');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { Bridge } from '../server/bridge.js';

async function fixture(work: (bridge: Bridge) => Promise<void>) {
  const parent = path.resolve('.subharness/tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'bounded bridge-'));
  const previous = process.env.SUBHARNESS_IMAGE_STORE;
  process.env.SUBHARNESS_IMAGE_STORE = path.join(root, 'images');
  const bridge = new Bridge(root, path.join(root, 'state'), true);
  try { await bridge.ready; await work(bridge); }
  finally {
    try { await bridge.close(); }
    finally {
      if (previous === undefined) delete process.env.SUBHARNESS_IMAGE_STORE;
      else process.env.SUBHARNESS_IMAGE_STORE = previous;
      assert(root.startsWith(parent + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  }
}

test('bridge bounds both terminated and unterminated stdout messages', { timeout: 20_000 }, async () => {
  for (const suffix of ['', '\n']) await fixture(async bridge => {
    const failed = once(bridge, 'failure');
    bridge.child.stdout.emit('data', `${'x'.repeat(16 * 1024 * 1024 + 1)}${suffix}`);
    const [error] = await failed;
    assert.match(error.message, /exceeds 16 MiB/);
    await assert.rejects(bridge.request({ version: 1, id: 'after-failure', method: 'session.list', params: {} }), /exceeds 16 MiB/);
    await bridge.closed;
  });
});

test('bridge shutdown terminates an unresponsive process tree after the EOF grace period', { timeout: 25_000 }, () => fixture(async bridge => {
  // Simulate a runtime that cannot receive EOF, while keeping the real child
  // available to exercise platform-specific process-tree cleanup.
  bridge.child.stdin.end = (() => bridge.child.stdin) as typeof bridge.child.stdin.end;
  const started = Date.now();
  await bridge.close();
  await bridge.closed;
  assert(Date.now() - started < 18_000, 'Shutdown must remain bounded.');
  assert.match(bridge.failure?.message ?? '', /did not stop after EOF/);
  assert(bridge.child.exitCode !== null || bridge.child.signalCode !== null);
}));

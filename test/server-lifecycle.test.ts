import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { startHost } from '../server/host.js';

type Host = Awaited<ReturnType<typeof startHost>>;
async function fixture(work: (root: string, open: (signal?: AbortSignal) => Promise<Host>) => Promise<void>) {
  const parent = path.resolve('.subharness/tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'host lifecycle with spaces-'));
  const previous = process.env.SUBHARNESS_IMAGE_STORE;
  process.env.SUBHARNESS_IMAGE_STORE = path.join(root, 'images');
  const hosts: Host[] = [];
  const open = async (signal?: AbortSignal) => {
    const host = await startHost({ cwd: root, port: 0, demo: true, stateDir: path.join(root, 'custom state with spaces') }, signal);
    hosts.push(host); return host;
  };
  try { await work(root, open); }
  finally {
    try { await Promise.allSettled(hosts.map(host => host.close())); }
    finally {
      if (previous === undefined) delete process.env.SUBHARNESS_IMAGE_STORE;
      else process.env.SUBHARNESS_IMAGE_STORE = previous;
      assert(root.startsWith(parent + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function post(host: Host, method: string, params: unknown = {}) {
  const response = await fetch(new URL(`/api/${method}`, host.url), {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, id: 'lifecycle', method, params }),
  });
  assert.equal(response.status, 200);
  const reply = await response.json() as { ok: boolean; result: any; error?: string };
  assert.equal(reply.ok, true, reply.error);
  return reply.result;
}

test('custom local sessions survive restart and shutdown closes an open SSE connection', { timeout: 30000 }, () => fixture(async (root, open) => {
  const first = await open();
  const created = await post(first, 'session.create', { direct: 'implement', title: 'Persisted custom state' });
  const sessionId = created.session.id;
  const response = await fetch(new URL('/api/events', first.url), {
    headers: { authorization: `Bearer ${first.token}` }, signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const ended = (async () => { for (;;) if ((await reader.read()).done) return; })();
  await Promise.all([first.close(), first.closed, ended]);
  await assert.rejects(readFile(path.join(first.stateDir, 'runner.lock')), { code: 'ENOENT' });
  const saved = JSON.parse(await readFile(path.join(first.stateDir, 'sessions', `${sessionId}.json`), 'utf8'));
  assert.equal(saved.title, 'Persisted custom state');
  await assert.rejects(readFile(path.join(root, '.subharness/sessions', `${sessionId}.json`)), { code: 'ENOENT' });
  const second = await open();
  assert(first.token !== second.token);
  const denied = await fetch(new URL('/api/host', second.url), {
    headers: { authorization: `Bearer ${first.token}` }, signal: AbortSignal.timeout(10000),
  });
  assert.equal(denied.status, 401);
  await denied.arrayBuffer();
  assert((await post(second, 'session.list')).some((session: { id: string }) => session.id === sessionId));
  const reopened = await post(second, 'session.open', { sessionId });
  assert.equal(reopened.session.title, saved.title);
  assert.equal(reopened.session.demo, true);
}));

test('unexpected CLI exit rejects closed, stops HTTP and preserves sessions for stale-lock recovery', { timeout: 30000 }, () => fixture(async (_root, open) => {
  const failed = await open();
  const created = await post(failed, 'session.create', { direct: 'implement', title: 'Before child failure' });
  const closed = assert.rejects(failed.closed, /CLI.*closed|CLI.*exit/i);
  assert(failed.child.kill('SIGKILL'));
  await closed;
  await assert.rejects(fetch(new URL('/api/host', failed.url), {
    headers: { authorization: `Bearer ${failed.token}` }, signal: AbortSignal.timeout(5000),
  }));
  const recovered = await open();
  const reopened = await post(recovered, 'session.open', { sessionId: created.session.id });
  assert.equal(reopened.session.title, 'Before child failure');
  const lock = JSON.parse(await readFile(path.join(recovered.stateDir, 'runner.lock'), 'utf8'));
  assert.equal(lock.pid, recovered.child.pid);
  assert.notEqual(lock.pid, failed.child.pid);
}));

test('aborting startup rejects with AbortError and leaves the project restartable', { timeout: 30000 }, () => fixture(async (root, open) => {
  const stateDir = path.join(root, 'custom state with spaces');
  const controller = new AbortController();
  const starting = open(controller.signal);
  controller.abort();
  await assert.rejects(starting, { name: 'AbortError' });
  await assert.rejects(readFile(path.join(stateDir, 'runner.lock')), { code: 'ENOENT' });
  assert.deepEqual(await post(await open(), 'session.list'), []);
}));

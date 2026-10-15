import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { startHost } from '../server/host.js';

type Host = Awaited<ReturnType<typeof startHost>>;
async function post(host: Host, method: string, params: unknown) {
  const response = await fetch(new URL(`/api/${method}`, host.url), {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, id: 'shutdown', method, params }),
  });
  assert.equal(response.status, 200);
  const reply = await response.json() as { ok: boolean; result: any; error?: string };
  assert.equal(reply.ok, true, reply.error);
  return reply.result;
}

test('host shutdown stops active demo work, flushes partial state and permits reopening', { timeout: 30000 }, async () => {
  const parent = path.resolve('.subharness/tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'active host shutdown with spaces-'));
  const stateDir = path.join(root, 'saved state with spaces');
  const previous = process.env.SUBHARNESS_IMAGE_STORE;
  process.env.SUBHARNESS_IMAGE_STORE = path.join(root, 'images');
  const hosts: Host[] = [];
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const open = async () => {
    const host = await startHost({ cwd: root, stateDir, port: 0, demo: true });
    hosts.push(host); return host;
  };
  try {
    const host = await open();
    const created = await post(host, 'session.create', { direct: 'implement', title: 'Interrupted demo' });
    const sessionId = created.session.id;
    const response = await fetch(new URL('/api/events', host.url), {
      headers: { authorization: `Bearer ${host.token}` }, signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200);
    reader = response.body!.getReader();
    assert.deepEqual(await post(host, 'session.submit', { sessionId, text: 'Offline active shutdown fixture' }), { accepted: true });
    const decoder = new TextDecoder();
    let buffer = '', running: any;
    while (!running) {
      const chunk = await reader.read();
      assert(!chunk.done, 'SSE ended before active worker output.');
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r', '');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').find(line => line.startsWith('data:'));
        if (!data) continue;
        const event = JSON.parse(data.slice(5));
        if (event.event === 'session.state' && event.sessionId === sessionId && event.state.busy &&
          event.state.session.tasks[0]?.status === 'running' && event.state.output.length > 0) running = event.state;
      }
    }
    assert.equal(running.session.runs[0].status, 'running');
    const ended = (async () => { for (;;) if ((await reader!.read()).done) return; })();
    await Promise.all([host.close(), host.closed, ended]);
    assert.equal(host.child.exitCode, 0);
    const saved = JSON.parse(await readFile(path.join(stateDir, 'sessions', `${sessionId}.json`), 'utf8'));
    assert.equal(saved.tasks[0].status, 'stopped');
    assert.equal(saved.runs[0].status, 'stopped');
    assert.equal(saved.inFlight, undefined);
    assert(saved.messages.some((message: { text: string }) => message.text.includes('Partial output')));
    assert(Object.values(saved.nativeSessions).some((native: any) => native.sessionId === 'demo-implement'));
    await assert.rejects(readFile(path.join(stateDir, 'runner.lock')), { code: 'ENOENT' });
    const reopened = await post(await open(), 'session.open', { sessionId });
    assert.equal(reopened.busy, false);
    assert.equal(reopened.session.tasks[0].status, 'stopped');
    assert.equal(reopened.session.runs[0].status, 'stopped');
    assert.deepEqual(reopened.session.messages, saved.messages);
  } finally {
    await reader?.cancel().catch(() => {});
    try { await Promise.allSettled(hosts.map(host => host.close())); }
    finally {
      if (previous === undefined) delete process.env.SUBHARNESS_IMAGE_STORE;
      else process.env.SUBHARNESS_IMAGE_STORE = previous;
      assert(root.startsWith(parent + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  }
});

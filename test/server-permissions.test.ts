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
    body: JSON.stringify({ version: 1, id: 'permissions', method, params }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ ok: boolean; result: any; error?: string }>;
}

test('HTTP forwards live-mode trust with exact IDs and denying it starts no native session', { timeout: 30000 }, async () => {
  const parent = path.resolve('.workerdeck/tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'host trust denial with spaces-'));
  const stateDir = path.join(root, 'isolated state');
  const previous = { WORKERDECK_IMAGE_STORE: process.env.WORKERDECK_IMAGE_STORE, WORKERDECK_OPENCODE_BIN: process.env.WORKERDECK_OPENCODE_BIN };
  process.env.WORKERDECK_IMAGE_STORE = path.join(root, 'images');
  // Keep a trust regression from reaching the user's native runtime or provider account.
  process.env.WORKERDECK_OPENCODE_BIN = path.join(root, 'native runtime disabled.exe');
  let host: Host | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await assert.rejects(readFile(path.join(stateDir, 'trust.json')), { code: 'ENOENT' });
    host = await startHost({ cwd: root, stateDir, port: 0, demo: false });
    const created = await post(host, 'session.create', { direct: 'implement' });
    assert.equal(created.ok, true);
    const sessionId = created.result.session.id;
    const response = await fetch(new URL('/api/events', host.url), {
      headers: { authorization: `Bearer ${host.token}` }, signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200);
    reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const state = async (check: (view: any) => boolean) => {
      for (;;) {
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const line = frame.split('\n').find(value => value.startsWith('data:'));
          if (!line) continue;
          const event = JSON.parse(line.slice(5));
          if (event.event === 'session.state' && event.sessionId === sessionId && check(event.state)) return event.state;
        }
        const chunk = await reader!.read();
        assert(!chunk.done, 'SSE ended before the expected trust state.');
        buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r', '');
      }
    };
    assert.deepEqual((await post(host, 'session.submit', { sessionId, text: 'Deny-only HTTP trust fixture' })).result, { accepted: true });
    const waiting = await state(view => Boolean(view.request));
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.request.kind, 'trust');
    assert.equal(waiting.request.title, 'Trust Builder?');
    assert.match(waiting.request.detail, /Source: .+\nSHA-256: [a-f0-9]{64}\nHarness: opencode/);
    assert.match(waiting.request.detail, /Skills: skills\/handoff\nPlugins: none/);
    assert.match(waiting.request.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
    const requestId = waiting.request.id;
    const stale = await post(host, 'request.respond', { sessionId, requestId: '00000000-0000-4000-8000-000000000000', answer: 'no' });
    assert.equal(stale.ok, false); assert.match(stale.error!, /no longer active/);
    const chat = await post(host, 'session.submit', { sessionId, text: 'yes' });
    assert.equal(chat.ok, false); assert.match(chat.error!, /request\.respond/);
    assert.equal((await post(host, 'session.get', { sessionId })).result.request.id, requestId);
    assert.equal((await post(host, 'request.respond', { sessionId, requestId, answer: 'no' })).ok, true);
    assert.equal((await post(host, 'request.respond', { sessionId, requestId, answer: 'no' })).ok, false);
    const denied = await state(view => !view.busy);
    assert.equal(denied.request, undefined);
    assert.match(denied.error, /not trusted/);
    assert.equal(denied.session.tasks[0].status, 'failed');
    assert.deepEqual(denied.session.nativeSessions, {});
    assert.equal(denied.session.runs.length, 1);
    assert.equal(denied.session.runs[0].status, 'failed');
    assert(denied.session.runs.every((run: { nativeSessionId?: string }) => run.nativeSessionId === undefined));
    await host.close(); await host.closed;
    await assert.rejects(readFile(path.join(stateDir, 'trust.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(stateDir, 'runner.lock')), { code: 'ENOENT' });
  } finally {
    await reader?.cancel().catch(() => {});
    try { await host?.close(); }
    finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      assert(root.startsWith(parent + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  }
});

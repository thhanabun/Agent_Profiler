import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProtocolEvent, ProtocolRequest, View } from '../../src/contracts.js';
import { HostApi, HostApiError, readEventStream, sameHost, SessionSnapshots, type Bootstrap, type HostEvent } from '../src/api.js';

const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';
const snapshot = (id: string, output = ''): View => ({
  busy: Boolean(output), phase: output ? 'Working' : 'Ready', paused: false, output, status: output ? 'running' : 'idle', availability: {},
  session: { version: 1, id, cwd: '/example/project', demo: true, title: `Session ${id}`, goal: '', planCount: 0,
    summary: '', needsPlan: false, steering: [], tasks: [], messages: [], runs: [], nativeSessions: {}, diffs: {} },
});
const stateEvent = (sequence: number, id: string, output = ''): Extract<ProtocolEvent, { event: 'session.state' }> =>
  ({ version: 1, event: 'session.state', sequence, sessionId: id, state: snapshot(id, output) });
const bootstrap = { token: 'memory-only-test-token', project: { name: 'Example', cwd: '/example/project' }, mode: 'demo', ready: true };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function chunks(text: string, sizes = [1, 3, 7, 2]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0, index = 0;
  return new ReadableStream({ pull(controller) {
    if (at >= bytes.length) { controller.close(); return; }
    const end = Math.min(bytes.length, at + sizes[index++ % sizes.length]!);
    controller.enqueue(bytes.slice(at, end)); at = end;
  } });
}

test('fetch SSE decodes split UTF-8, CRLF boundaries, comments, and multiline JSON data', async () => {
  const expected: HostEvent[] = [{ version: 1, event: 'ready', methods: [] }, stateEvent(4, a, 'พร้อมทำงาน')];
  const text = ': keepalive\r\n\r\n' + expected.map(value => 'event: message\r\n' +
    JSON.stringify(value, null, 2).split('\n').map(line => `data: ${line}\r\n`).join('') + '\r\n').join('');
  const events: HostEvent[] = [];
  await readEventStream(chunks(text), event => events.push(event));
  assert.deepEqual(events, expected);
});

test('SSE rejects malformed or cross-session snapshots instead of publishing them', async () => {
  await assert.rejects(readEventStream(chunks('data: not-json\n\n'), () => assert.fail()), /unreadable event/);
  await assert.rejects(readEventStream(chunks(`data: ${JSON.stringify({ ...stateEvent(2, a), sessionId: b })}\n\n`), () => assert.fail()), /invalid session event/);
});

test('aborting an idle SSE stream cancels the reader and exits without waiting for more events', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = readEventStream(stream, () => assert.fail(), controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
  assert.equal(cancelled, true);
});

test('browser API sends full protocol envelopes and keeps bearer credentials out of event URLs', async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  let request: ProtocolRequest | undefined;
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input); calls.push({ url, options });
    if (url === '/api/bootstrap') return json(bootstrap);
    assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${bootstrap.token}`);
    if (url === '/api/events') return new Response(chunks(`data: ${JSON.stringify(stateEvent(1, a, 'First chunk'))}\n\n`), { headers: { 'Content-Type': 'text/event-stream' } });
    request = JSON.parse(String(options?.body)) as ProtocolRequest;
    return json({ version: 1, id: request.id, ok: true, result: { accepted: true } });
  };
  const api = new HostApi(fetcher);
  assert.deepEqual(await api.bootstrap(), bootstrap);
  assert.deepEqual(await api.rpc('session.submit', { sessionId: a, text: 'Explicit user message' }), { accepted: true });
  assert.equal(request?.version, 1);
  assert.equal(request?.method, 'session.submit');
  assert.deepEqual(request?.params, { sessionId: a, text: 'Explicit user message' });
  assert.match(request!.id, /^[a-f0-9-]{36}$/);
  const events: HostEvent[] = [];
  let opened = false;
  await assert.rejects(api.events({ signal: new AbortController().signal, onOpen() { opened = true; }, onEvent: event => events.push(event) }), /connection.*closed/i);
  assert.equal(opened, true);
  assert.deepEqual(events, [stateEvent(1, a, 'First chunk')]);
  assert(calls.every(call => !call.url.includes(bootstrap.token) && !call.url.includes('?')));
  assert.equal(calls[1]!.options?.method, 'POST');
});

test('RPC reports host errors and rejects mismatched response identities', async () => {
  let wrongId = false;
  const api = new HostApi(async (input, options) => {
    if (String(input) === '/api/bootstrap') return json(bootstrap);
    const request = JSON.parse(String(options?.body)) as ProtocolRequest;
    return json(wrongId ? { version: 1, id: 'another-request', ok: true, result: [] } :
      { version: 1, id: request.id, ok: false, error: 'Open this session before sending commands to it.' });
  });
  await api.bootstrap();
  await assert.rejects(api.rpc('session.list', {}), /Open this session/);
  wrongId = true;
  await assert.rejects(api.rpc('session.list', {}), /different command/);
});

test('host.error SSE events reach the controller and network failures give a useful local-host error', async () => {
  const events: HostEvent[] = [];
  await readEventStream(chunks('data: {"event":"host.error","error":"Native host exited"}\n\n'), event => events.push(event));
  assert.deepEqual(events, [{ event: 'host.error', error: 'Native host exited' }]);
  const api = new HostApi(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(api.bootstrap(), error => error instanceof HostApiError && error.kind === 'network' && /local Subharness host/.test(error.message));
});

test('snapshots replace streamed output and ignore duplicate and decreasing sequence numbers', () => {
  const snapshots = new SessionSnapshots();
  assert.equal(snapshots.accept(stateEvent(1, a, 'Hello'))?.output, 'Hello');
  assert.equal(snapshots.accept(stateEvent(2, a, 'Hello world'))?.output, 'Hello world');
  assert.equal(snapshots.accept(stateEvent(2, a, 'duplicate')), null);
  assert.equal(snapshots.accept(stateEvent(1, a, 'old')), null);
  assert.equal(snapshots.sequence, 2);
});

test('switching sessions excludes old-session events and retains a newer target snapshot over its RPC response', () => {
  const snapshots = new SessionSnapshots();
  snapshots.accept(stateEvent(1, a, 'A'));
  const generation = snapshots.beginSelection();
  assert.equal(snapshots.accept(stateEvent(2, a, 'Late A')), null);
  assert.equal(snapshots.accept(stateEvent(3, b, 'New B')), null);
  assert.equal(snapshots.finishSelection(snapshot(b, 'Earlier B response'), generation)?.output, 'New B');
  assert.equal(snapshots.activeId, b);
  assert.equal(snapshots.accept(stateEvent(4, a, 'Unrelated A')), null);
  assert.equal(snapshots.accept(stateEvent(5, b, 'Latest B'))?.output, 'Latest B');
});

test('a failed switch recovers active state and a late refresh cannot overwrite newer SSE or another session', () => {
  const snapshots = new SessionSnapshots();
  snapshots.accept(stateEvent(1, a));
  const before = snapshots.generation;
  const selection = snapshots.beginSelection();
  snapshots.accept(stateEvent(2, a, 'Progress while opening'));
  assert.equal(snapshots.cancelSelection(selection)?.output, 'Progress while opening');
  assert.equal(snapshots.switching, false);
  assert.equal(snapshots.refreshed(snapshot(a, 'Stale refresh'), a, 1, before), null);
  const generation = snapshots.generation;
  assert.equal(snapshots.refreshed(snapshot(a, 'Fresh refresh'), a, 2, generation)?.output, 'Fresh refresh');
  snapshots.accept(stateEvent(3, a, 'Newer event'));
  assert.equal(snapshots.refreshed(snapshot(a, 'Old response'), a, 2, generation), null);
  const change = snapshots.beginSelection();
  snapshots.finishSelection(snapshot(b), change);
  assert.equal(snapshots.refreshed(snapshot(a), a, 3, generation), null);
  snapshots.resetHost();
  assert.equal(snapshots.activeId, null);
  assert.equal(snapshots.accept(stateEvent(1, b, 'Restarted host'))?.output, 'Restarted host');
});

test('old cached target states and in-flight selection responses cannot survive a new host epoch', () => {
  const snapshots = new SessionSnapshots();
  snapshots.accept(stateEvent(1, a));
  snapshots.accept(stateEvent(2, b, 'Earlier cached B'));
  const first = snapshots.beginSelection();
  assert.throws(() => snapshots.beginSelection(), /already being opened/);
  assert.equal(snapshots.finishSelection(snapshot(b, 'Fresh RPC snapshot'), first)?.output, 'Fresh RPC snapshot');
  const outstanding = snapshots.beginSelection();
  const oldEpoch = snapshots.hostEpoch;
  const oldGeneration = snapshots.generation;
  snapshots.resetHost();
  assert.equal(snapshots.activeId, null);
  assert.equal(snapshots.switching, false);
  assert.equal(snapshots.finishSelection(snapshot(a, 'Response from previous host'), outstanding), null);
  assert.equal(snapshots.cancelSelection(outstanding), null);
  assert.equal(snapshots.refreshed(snapshot(b, 'Old refresh'), b, 2, oldGeneration), null);
  assert.equal(snapshots.accept(stateEvent(100, b, 'Late event from previous host'), oldEpoch), null);
  assert.equal(snapshots.activeId, null);
  assert.equal(snapshots.accept(stateEvent(1, b, 'New host state'))?.output, 'New host state');
});

test('same-host reconnects retain identity but a new token, execution mode, or project starts a new host', () => {
  const current: Bootstrap = { ...bootstrap, mode: 'live' };
  assert.equal(sameHost(current, { ...current, ready: false }), true);
  assert.equal(sameHost(current, { ...current, token: 'new-host-token' }), false);
  assert.equal(sameHost(current, { ...current, mode: 'demo' }), false);
  assert.equal(sameHost(current, { ...current, project: { ...current.project, cwd: '/another/project' } }), false);
  assert.equal(sameHost(current, { ...current, project: { ...current.project, name: 'Different project' } }), false);
});

test('a late bootstrap response cannot roll the API credentials back to a previous host', async () => {
  let resolveOld!: (response: Response) => void;
  let calls = 0;
  const latest: Bootstrap = { ...bootstrap, mode: 'demo', token: 'new-host-token' };
  const api = new HostApi(async (input, options) => {
    if (String(input) === '/api/bootstrap') {
      calls++;
      if (calls === 1) return new Promise<Response>(resolve => { resolveOld = resolve; });
      return json(latest);
    }
    assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${latest.token}`);
    const request = JSON.parse(String(options?.body)) as ProtocolRequest;
    return json({ version: 1, id: request.id, ok: true, result: [] });
  });
  const pendingOld = api.bootstrap();
  assert.deepEqual(await api.bootstrap(), latest);
  resolveOld(json(bootstrap));
  assert.deepEqual(await pendingOld, latest);
  assert.deepEqual(await api.rpc('session.list', {}), []);
});

test('legacy host startup requires a memory-only token and rejects blank or invalid credentials as auth failures', async () => {
  const urls: string[] = [];
  const api = new HostApi(async (input, options) => {
    const url = String(input); urls.push(url);
    if (url === '/api/bootstrap') return json({ error: 'Bearer token required.' }, 401);
    assert.equal(url, '/api/host');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer wrong-token');
    return json({ error: 'Bearer token required.' }, 401);
  });
  assert.throws(() => api.setToken('  \n '), error => error instanceof HostApiError && error.kind === 'auth');
  await assert.rejects(api.bootstrap(), error => error instanceof HostApiError && error.kind === 'auth');
  assert.deepEqual(urls, ['/api/bootstrap']);
  api.setToken('wrong-token');
  await assert.rejects(api.bootstrap(), error => error instanceof HostApiError && error.kind === 'auth' && error.status === 401);
  assert.deepEqual(urls, ['/api/bootstrap', '/api/bootstrap', '/api/host']);
});

test('legacy 401/404 fallback authenticates host metadata, uses per-method envelopes, and reads named SSE', async () => {
  for (const fallbackStatus of [401, 404]) {
    const calls: string[] = [];
    const token = 'configured-host-token';
    const api = new HostApi(async (input, options) => {
      const url = String(input); calls.push(url);
      if (url === '/api/bootstrap') {
        assert.equal(new Headers(options?.headers).get('Authorization'), null);
        return new Response('Unavailable automatic bootstrap', { status: fallbackStatus });
      }
      assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${token}`);
      if (url === '/api/host') return json({ cwd: 'C:\\work\\Shared Project\\', stateDir: 'C:\\work\\state', demo: true, methods: ['session.list'] });
      if (url === '/api/events') return new Response(chunks(`event: session.state\ndata: ${JSON.stringify(stateEvent(1, a))}\n\n`), { headers: { 'Content-Type': 'text/event-stream' } });
      assert.equal(url, '/api/session.list');
      assert.equal(options?.method, 'POST');
      const request = JSON.parse(String(options?.body)) as ProtocolRequest;
      assert.equal(request.version, 1);
      assert.equal(request.method, 'session.list');
      assert.deepEqual(request.params, {});
      return json({ version: 1, id: request.id, ok: true, result: [] });
    });
    api.setToken(` ${token} `);
    assert.deepEqual(await api.bootstrap(), { token, project: { name: 'Shared Project', cwd: 'C:\\work\\Shared Project\\' }, mode: 'demo', ready: true });
    assert.deepEqual(await api.rpc('session.list', {}), []);
    const received: HostEvent[] = [];
    await assert.rejects(api.events({ signal: new AbortController().signal, onEvent: event => received.push(event) }), /connection.*closed/i);
    assert.deepEqual(received, [stateEvent(1, a)]);
    assert.deepEqual(calls, ['/api/bootstrap', '/api/host', '/api/session.list', '/api/events']);
    assert(calls.every(url => !url.includes(token) && !url.includes('?')));
  }
});

test('token rotation returns auth failures from RPC, bootstrap, and SSE until a new token is supplied', async () => {
  let currentToken = 'first-token';
  const api = new HostApi(async (input, options) => {
    const url = String(input);
    if (url === '/api/bootstrap') return json({ error: 'Route not found.' }, 404);
    if (new Headers(options?.headers).get('Authorization') !== `Bearer ${currentToken}`) return json({ error: 'Bearer token required.' }, 401);
    if (url === '/api/host') return json({ cwd: '/work/project', stateDir: '/work/state', demo: false, methods: ['session.list'] });
    const request = JSON.parse(String(options?.body)) as ProtocolRequest;
    return json({ version: 1, id: request.id, ok: true, result: [] });
  });
  api.setToken(currentToken);
  const first = await api.bootstrap();
  currentToken = 'rotated-token';
  const auth = (error: unknown) => error instanceof HostApiError && error.kind === 'auth';
  await assert.rejects(api.rpc('session.list', {}), auth);
  await assert.rejects(api.events({ signal: new AbortController().signal, onEvent: () => assert.fail() }), auth);
  await assert.rejects(api.bootstrap(), auth);
  api.setToken(currentToken);
  const next = await api.bootstrap();
  assert.equal(next.token, currentToken);
  assert.equal(sameHost(first, next), false);
  assert.deepEqual(await api.rpc('session.list', {}), []);
});

test('automatic aliases remain preferred when they become available after a legacy connection', async () => {
  let automatic = false;
  const routes: string[] = [];
  const api = new HostApi(async (input, options) => {
    const url = String(input); routes.push(url);
    if (url === '/api/bootstrap') return automatic ? json(bootstrap) : json({ error: 'Not found' }, 404);
    if (url === '/api/host') return json({ cwd: '/work/project', stateDir: '/work/state', demo: false, methods: ['session.list'] });
    const request = JSON.parse(String(options?.body)) as ProtocolRequest;
    return json({ version: 1, id: request.id, ok: true, result: [] });
  });
  api.setToken('legacy-token');
  await api.bootstrap();
  await api.rpc('session.list', {});
  automatic = true;
  await api.bootstrap();
  await api.rpc('session.list', {});
  assert.deepEqual(routes, ['/api/bootstrap', '/api/host', '/api/session.list', '/api/bootstrap', '/api/rpc']);
});

test('manual token replacement invalidates an outstanding automatic bootstrap response', async () => {
  let finish!: (response: Response) => void;
  const api = new HostApi(async () => new Promise<Response>(resolve => { finish = resolve; }));
  const pending = api.bootstrap();
  api.setToken('new-manually-entered-token');
  finish(json(bootstrap));
  await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
});

test('a successful HTTP refresh remains the rollback snapshot after a failed session open', () => {
  const snapshots = new SessionSnapshots();
  const waiting = stateEvent(1, a, 'Earlier streamed output');
  waiting.state.status = 'waiting';
  waiting.state.request = { id: '30000000-0000-4000-8000-000000000001', kind: 'trust', title: 'Earlier trust request', detail: 'Old request' };
  snapshots.accept(waiting);
  const ready = snapshot(a);
  assert.equal(snapshots.refreshed(ready, a, 1, snapshots.generation), ready);
  const opening = snapshots.beginSelection();
  const restored = snapshots.cancelSelection(opening);
  assert.deepEqual(restored, ready);
  assert.equal(restored?.busy, false);
  assert.equal(restored?.request, undefined);
  assert.equal(restored?.output, '');
  snapshots.accept(stateEvent(2, a, 'New work after refresh'));
  const laterOpen = snapshots.beginSelection();
  assert.equal(snapshots.cancelSelection(laterOpen)?.output, 'New work after refresh');
});

test('a fresh create/open RPC snapshot replaces an older target snapshot in the rollback cache', () => {
  const snapshots = new SessionSnapshots();
  snapshots.accept(stateEvent(1, a));
  snapshots.accept(stateEvent(2, b, 'Earlier B output'));
  const opening = snapshots.beginSelection();
  const fresh = snapshot(b);
  assert.equal(snapshots.finishSelection(fresh, opening), fresh);
  const failedNextOpen = snapshots.beginSelection();
  assert.deepEqual(snapshots.cancelSelection(failedNextOpen), fresh);
});

test('automatic-host 401 refreshes bootstrap once and never replays mutations onto a new host', async () => {
  const commands: Array<{ method: 'session.submit' | 'session.create' | 'request.respond'; params: unknown }> = [
    { method: 'session.submit', params: { sessionId: a, text: 'Explicit message for the original host' } },
    { method: 'session.create', params: { direct: 'codex' } },
    { method: 'request.respond', params: { sessionId: a, requestId: '30000000-0000-4000-8000-000000000001', answer: 'yes' } },
  ];
  for (const command of commands) {
    let bootstrapCalls = 0, mutationCalls = 0;
    const next: Bootstrap = { ...bootstrap, token: 'restarted-host-token', mode: 'live', project: { name: 'Other project', cwd: '/another/project' } };
    const api = new HostApi(async (input, options) => {
      const url = String(input);
      if (url === '/api/bootstrap') return json(++bootstrapCalls === 1 ? bootstrap : next);
      assert.equal(url, '/api/rpc');
      const request = JSON.parse(String(options?.body)) as ProtocolRequest;
      if (request.method === 'session.list') {
        assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${next.token}`);
        return json({ version: 1, id: request.id, ok: true, result: [] });
      }
      mutationCalls++;
      assert.equal(request.method, command.method);
      assert.deepEqual(request.params, command.params);
      assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${bootstrap.token}`);
      return json({ error: 'Bearer token required.' }, 401);
    });
    await api.bootstrap();
    await assert.rejects(api.rpc(command.method, command.params as never), error => error instanceof HostApiError && error.kind === 'reconnect');
    assert.equal(bootstrapCalls, 2);
    assert.equal(mutationCalls, 1);
    assert.deepEqual(await api.rpc('session.list', {}), []);
    assert.equal(mutationCalls, 1);
  }
});

test('automatic SSE 401 signals reconnect after one bootstrap refresh without reopening the stream itself', async () => {
  let bootstrapCalls = 0, streamCalls = 0, opened = false;
  const next: Bootstrap = { ...bootstrap, mode: 'demo', token: 'new-stream-token' };
  const api = new HostApi(async (input, options) => {
    if (String(input) === '/api/bootstrap') return json(++bootstrapCalls === 1 ? bootstrap : next);
    assert.equal(String(input), '/api/events');
    streamCalls++;
    if (streamCalls === 1) return json({ error: 'Bearer token required.' }, 401);
    assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${next.token}`);
    return new Response(chunks('event: ready\ndata: {"version":1,"event":"ready","methods":[]}\n\n'), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  await api.bootstrap();
  await assert.rejects(api.events({ signal: new AbortController().signal, onOpen() { opened = true; }, onEvent: () => assert.fail() }), error => error instanceof HostApiError && error.kind === 'reconnect');
  assert.equal(opened, false);
  assert.equal(bootstrapCalls, 2);
  assert.equal(streamCalls, 1);
  const events: HostEvent[] = [];
  await assert.rejects(api.events({ signal: new AbortController().signal, onEvent: event => events.push(event) }), /connection.*closed/i);
  assert.equal(streamCalls, 2);
  assert.deepEqual(events, [{ version: 1, event: 'ready', methods: [] }]);
});

test('automatic refresh requests manual authentication if only an unauthorized legacy host remains', async () => {
  let first = true, mutations = 0;
  const api = new HostApi(async (input) => {
    const url = String(input);
    if (url === '/api/bootstrap') {
      if (first) { first = false; return json(bootstrap); }
      return json({ error: 'Not found' }, 404);
    }
    if (url === '/api/host') return json({ error: 'Bearer token required.' }, 401);
    assert.equal(url, '/api/rpc');
    mutations++;
    return json({ error: 'Bearer token required.' }, 401);
  });
  await api.bootstrap();
  await assert.rejects(api.rpc('session.submit', { sessionId: a, text: 'Do not replay' }), error => error instanceof HostApiError && error.kind === 'auth');
  assert.equal(mutations, 1);
});

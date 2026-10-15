import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { startHost } from '../server/host.js';

type Host = Awaited<ReturnType<typeof startHost>>;
async function fixture(work: (host: Host, root: string) => Promise<void>) {
  const parent = path.resolve('.subharness/tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'http host project with spaces-'));
  const previous = process.env.SUBHARNESS_IMAGE_STORE;
  process.env.SUBHARNESS_IMAGE_STORE = path.join(root, 'images');
  let host: Host | undefined;
  try { host = await startHost({ cwd: root, port: 0, demo: true }); await work(host, root); }
  finally {
    try { await host?.close(); }
    finally {
      if (previous === undefined) delete process.env.SUBHARNESS_IMAGE_STORE;
      else process.env.SUBHARNESS_IMAGE_STORE = previous;
      assert(root.startsWith(parent + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  }
}

function http(host: Host, route: string, body?: string | Buffer, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(new URL(route, host.url), {
      method: body === undefined ? 'GET' : 'POST', timeout: 10000,
      headers: { authorization: `Bearer ${host.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    }, res => {
      let text = '';
      res.setEncoding('utf8').on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: text, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject).on('timeout', () => req.destroy(new Error('HTTP fixture timed out.')));
    req.end(body);
  });
}
const envelope = (method: string, params: unknown = {}, id = 'fixture') => JSON.stringify({ version: 1, id, method, params });
const post = async (host: Host, method: string, params: unknown = {}, id = 'fixture') =>
  JSON.parse((await http(host, `/api/${method}`, envelope(method, params, id))).body);

async function events(host: Host) {
  const controller = new AbortController();
  const response = await fetch(new URL('/api/events', host.url), {
    headers: { authorization: `Bearer ${host.token}` },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async (): Promise<{ event: string; data: any }> => {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const lines = frame.split('\n');
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) return { event: lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message', data: JSON.parse(data) };
        continue;
      }
      const chunk = await reader.read();
      assert(!chunk.done, 'SSE ended before the expected event.');
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r', '');
    }
  };
  const until = async (check: (frame: Awaited<ReturnType<typeof next>>) => boolean) => {
    for (let count = 0; count < 100; count++) { const frame = await next(); if (check(frame)) return frame; }
    assert.fail('Expected SSE event was not received.');
  };
  return { next, until, close: async () => { controller.abort(); await reader.cancel().catch(() => {}); } };
}

test('HTTP host authenticates, bounds requests and isolates concurrent request IDs', { timeout: 30000 }, () => fixture(async (host, root) => {
  const route = '/api/session.list', body = envelope('session.list');
  assert.equal((await http(host, route, body, { authorization: '' })).status, 401);
  assert.equal((await http(host, route, body, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await http(host, route, body, { host: 'attacker.example' })).status, 403);
  assert.equal((await http(host, route, body, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await http(host, route, body, { origin: 'null' })).status, 403);
  const valid = await http(host, route, body, { origin: new URL(host.url).origin });
  assert.equal(valid.status, 200);
  assert.equal(valid.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(JSON.parse(valid.body), { version: 1, id: 'fixture', ok: true, result: [] });
  assert.equal((await http(host, route, body + '\n' + body)).status, 400);
  assert.equal((await http(host, route, envelope('session.open'))).status, 400);
  assert.equal((await http(host, route + '?token=ignored', body)).status, 400);
  assert.equal((await http(host, route, body, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await http(host, route, ' '.repeat(65537))).status, 413);
  const padding = 'x'.repeat(65535 - Buffer.byteLength(envelope('session.list', { padding: '' }, 'x')));
  assert.equal((await http(host, route, envelope('session.list', { padding }, 'x'))).status, 413);
  const injected = await post(host, 'session.create', { cwd: root, direct: 'implement' });
  assert.equal(injected.ok, false);
  assert.equal((await http(host, '/api/session.create', envelope('session.create', { direct: root }))).status, 403);
  assert.deepEqual((await post(host, 'session.list')).result, []);
  const [sessions, profiles] = await Promise.all([
    post(host, 'session.list', {}, 'same-id'), post(host, 'profiles.list', {}, 'same-id'),
  ]);
  assert.equal(sessions.id, 'same-id'); assert.equal(profiles.id, 'same-id');
  assert.equal(sessions.ok, true); assert.equal(profiles.ok, true);
  assert.deepEqual(sessions.result, []);
  assert(profiles.result.some((profile: { id: string }) => profile.id === 'implement'));
}));

test('static navigation needs no token while API routes remain private', { timeout: 15000 }, () => fixture(async host => {
  const page = await http(host, '/?asset-version=1', undefined, { authorization: '' });
  assert([200, 503].includes(page.status));
  assert(!page.body.includes(host.token));
  assert.equal((await http(host, '/', undefined, { host: 'attacker.example', authorization: '' })).status, 403);
  for (const route of ['/api/host', '/api/events', '/api/missing'])
    assert.equal((await http(host, route, undefined, { authorization: '' })).status, 401);
  assert.equal((await http(host, '/api/missing', undefined, { accept: 'text/html' })).status, 404);
}));

test('loopback guards reject browser bypasses and bound authenticated SSE clients', { timeout: 30000 }, () => fixture(async host => {
  const route = '/api/session.list', body = envelope('session.list');
  const port = new URL(host.url).port;
  const rejectedHeaders: Record<string, string>[] = [
    { host: `localhost:${port}` }, { host: '127.0.0.1:1' },
    { origin: `http://localhost:${port}` }, { origin: host.url + '/' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
  ];
  for (const headers of rejectedHeaders) {
    const denied = await http(host, route, body, headers);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  }
  for (const site of ['same-origin', 'none'])
    assert.equal((await http(host, route, body, { origin: host.url, 'sec-fetch-site': site })).status, 200);
  assert.equal((await http(host, `/api/host?token=${host.token}`, undefined, { authorization: '' })).status, 401);
  assert.equal((await http(host, route, Buffer.from([0xc3, 0x28]))).status, 400);
  const allowed = await http(host, route, body, { 'x-forwarded-host': 'attacker.example' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['access-control-allow-origin'], undefined);
  const streams: Awaited<ReturnType<typeof events>>[] = [];
  try {
    for (let count = 0; count < 16; count++) streams.push(await events(host));
    assert.equal((await http(host, '/api/events')).status, 429);
    assert.deepEqual((await post(host, 'session.list')).result, []);
  } finally { await Promise.all(streams.map(stream => stream.close())); }
}));

test('browser configuration stays fixed and all operations retain strict protocol validation', { timeout: 20000 }, () => fixture(async (host, root) => {
  const metadata = JSON.parse((await http(host, '/api/host')).body);
  assert.equal(metadata.cwd, host.cwd);
  assert.equal(metadata.stateDir, path.join(host.cwd, '.subharness'));
  const choices = await post(host, 'profiles.choices');
  assert(choices.result.some((choice: { reference: string }) => choice.reference === 'implement'));
  for (const params of [{ direct: root }, { orchestrator: root }, { workers: [root] }])
    assert.equal((await http(host, '/api/session.create', envelope('session.create', params))).status, 403);
  for (const field of ['cwd', 'stateDir', 'executable', 'shell', 'command', 'credentials', 'apiKey']) {
    const rejected = await post(host, 'session.create', { direct: 'implement', [field]: 'browser-supplied' });
    assert.equal(rejected.ok, false, field);
    assert.match(rejected.error, /Unrecognized key/);
  }
  assert.deepEqual((await post(host, 'session.list')).result, []);
  const session = await post(host, 'session.create', { direct: 'implement', title: 'Fixed project' });
  assert.equal(session.ok, true);
  const sessionId = session.result.session.id;
  const params: Record<string, Record<string, unknown>> = {
    'profiles.list': {}, 'profiles.choices': {}, 'session.list': {}, 'session.create': { direct: 'implement' },
    'session.open': { sessionId }, 'session.get': { sessionId }, 'session.rename': { sessionId, title: 'Rejected' },
    'session.submit': { sessionId, text: 'Rejected' }, 'session.stop': { sessionId }, 'session.pause': { sessionId },
    'session.resume': { sessionId }, 'session.retry': { sessionId },
    'session.assign': { sessionId, taskId: 'missing', profileId: 'implement' },
    'request.respond': { sessionId, requestId: sessionId, answer: 'no' },
  };
  assert.deepEqual(Object.keys(params).sort(), [...metadata.methods].sort());
  for (const [method, fields] of Object.entries(params)) {
    const rejected = await post(host, method, { ...fields, credentials: 'browser-supplied' });
    assert.equal(rejected.ok, false, method);
    assert.match(rejected.error, /Unrecognized key/);
  }
  assert.equal((await post(host, 'session.open', { sessionId: '../outside' })).ok, false);
  const current = await post(host, 'session.get', { sessionId });
  assert.equal(current.result.session.title, 'Fixed project');
  assert.deepEqual(current.result.session.tasks, []);
  assert.deepEqual(JSON.parse((await http(host, '/api/host')).body), metadata);
}));

test('SSE relays demo state and errors, replays latest state, and retains local sessions', { timeout: 30000 }, () => fixture(async (host, root) => {
  const stream = await events(host);
  let reconnected: Awaited<ReturnType<typeof events>> | undefined;
  try {
    const ready = await stream.next();
    assert.equal(ready.event, 'ready'); assert.equal(ready.data.version, 1);
    assert((await post(host, 'profiles.choices')).ok);
    const created = await post(host, 'session.create', { direct: 'implement', title: 'HTTP demo' });
    assert.equal(created.ok, true);
    const sessionId = created.result.session.id;
    assert.deepEqual((await post(host, 'session.submit', { sessionId, text: 'Offline HTTP fixture' })).result, { accepted: true });
    const finished = await stream.until(frame => frame.data.event === 'session.state' &&
      frame.data.state.session.id === sessionId && !frame.data.state.busy && frame.data.state.session.tasks[0]?.status === 'completed');
    assert.equal(finished.event, 'session.state');
    assert.equal(finished.data.state.session.demo, true);
    await stream.close();
    reconnected = await events(host);
    assert.equal((await reconnected.next()).event, 'ready');
    const replay = await reconnected.next();
    assert.equal(replay.event, 'session.state');
    assert.equal(replay.data.state.session.id, sessionId);
    assert.equal(replay.data.state.session.tasks[0].status, 'completed');
    assert((await post(host, 'session.retry', { sessionId })).result.accepted);
    const error = await reconnected.until(frame => frame.data.event === 'operation.error');
    assert.equal(error.event, 'operation.error'); assert.equal(error.data.sessionId, sessionId);
    const metadata = await http(host, '/api/host');
    assert.equal(metadata.status, 200);
    assert(!metadata.body.includes(host.token));
    await reconnected.close();
    await host.close();
    await host.closed;
    const saved = JSON.parse(await readFile(path.join(root, '.subharness/sessions', `${sessionId}.json`), 'utf8'));
    assert.equal(saved.tasks[0].status, 'completed');
    await assert.rejects(readFile(path.join(root, '.subharness/runner.lock')), { code: 'ENOENT' });
  } finally { await stream.close(); await reconnected?.close(); }
}));

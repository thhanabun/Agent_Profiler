import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionManager, Engine, serveStdio } from '../src/core.js';
import { readSession } from '../src/engine.js';
import { loadProfiles, forkProfile } from '../src/profiles.js';
import type { Runner } from '../src/adapters.js';

async function temp(work: (root: string) => Promise<void>) {
  const parent = path.resolve('.subharness/tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'application-'));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const task = (profileId: string) => ({ id: 'work', title: 'Work', goal: 'Deliver', profileId, reason: 'Selected specialist', dependsOn: [], acceptance: ['Delivered'] });
const managerFor = (root: string, runner: Runner) => new SessionManager({ cwd: root, stateRoot: path.join(root, 'state'), store: path.join(root, 'images'), extraRoot: path.join(root, 'profiles'), demo: true, runner });

test('session transitions cannot overlap and shutdown waits for creation to finish', async () => temp(async root => {
  const manager = managerFor(root, async () => ({ text: 'Hi', sessionId: 'p' }));
  const creating = manager.create({ direct: 'implement' });
  await assert.rejects(manager.create({ direct: 'codex' }), /already being opened/);
  await manager.shutdown();
  assert.equal((await creating).state.session.selection!.directProfileId, 'implement');
  await assert.rejects(manager.open('latest'), /closing/);
  assert.equal((await manager.list()).length, 1);
}));

test('session assigns roles independently of profile hints and records native runs', async () => temp(async root => {
  const calls: Array<{ id: string; role?: string }> = [];
  const manager = managerFor(root, async input => {
    calls.push({ id: input.profile.manifest.id, role: input.role });
    input.onEvent({ kind: 'session', sessionId: `native-${input.profile.manifest.id}`, text: '' });
    return input.schema ? { text: '', structured: { summary: 'Delegate to OpenCode', tasks: [task('orchestrator')] }, sessionId: 'claude-planner' }
      : { text: 'Delivered', sessionId: 'opencode-worker' };
  });
  const engine = await manager.create({ title: 'Claude leads', orchestrator: 'ui', workers: ['orchestrator'] });
  await engine.submit('Build');
  assert.equal(engine.state.error, undefined);
  assert.deepEqual(calls, [{ id: 'ui', role: 'orchestrator' }, { id: 'orchestrator', role: 'worker' }]);
  assert.equal(engine.state.status, 'idle');
  assert.equal(engine.state.session.runs.length, 2);
  assert.deepEqual(engine.state.session.runs.map(run => [run.harness, run.status, run.nativeSessionId]), [['claude', 'completed', 'claude-planner'], ['opencode', 'completed', 'opencode-worker']]);
  assert(engine.state.session.runs.every(run => run.endedAt));
  await engine.rename('My team');
  const reopened = await manager.open(engine.state.session.id);
  assert.equal(reopened.orchestratorProfileId, 'ui');
  assert.deepEqual(reopened.workerProfileIds, ['orchestrator']);
  assert.equal(reopened.state.session.title, 'My team');
  assert.equal((await manager.list()).length, 1);
  await assert.rejects(manager.create({ orchestrator: 'ui', workers: ['ui'] }), /unique|selection/);
}));

test('planner cannot select a loaded profile outside the selected worker pool', async () => temp(async root => {
  const engine = new Engine({ cwd: root, stateRoot: root, profiles: await loadProfiles(), demo: true,
    orchestratorProfileId: 'ui', workerProfileIds: ['orchestrator'],
    runner: async () => ({ text: '', structured: { summary: 'Invalid', tasks: [task('implement')] }, sessionId: 'p' }) });
  await engine.submit('Build');
  assert.match(engine.state.error!, /Unavailable worker/);
  assert.equal(engine.state.status, 'error');
  assert.equal(engine.state.session.tasks.length, 0);
}));

test('session restores source configuration and rejects source/model changes', async () => temp(async root => {
  const manager = managerFor(root, async () => ({ text: 'Hi', sessionId: 'p' }));
  const source = path.join(root, 'custom profile');
  await forkProfile((await loadProfiles()).find(p => p.manifest.id === 'implement')!, source, 'custom');
  const engine = await manager.create({ direct: source });
  await engine.submit('Hello');
  assert.equal(engine.state.session.title, 'Hello');
  const reopened = await manager.open('latest');
  assert.equal(reopened.state.session.selection!.directProfileId, 'custom');
  process.env.SUBHARNESS_MODEL_CUSTOM = 'different/model';
  try { await assert.rejects(manager.open('latest'), /models or role assignments changed/); }
  finally { delete process.env.SUBHARNESS_MODEL_CUSTOM; }
  const file = path.join(source, 'profile.json');
  const manifest = JSON.parse(await readFile(file, 'utf8')); manifest.instructions += ' Changed.';
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(manager.open('latest'), /profiles, models or role assignments changed/);
}));

test('retry and crash recovery preserve distinct run attempts', async () => temp(async root => {
  let fail = true;
  const manager = managerFor(root, async () => { if (fail) throw new Error('Offline'); return { text: 'Recovered', sessionId: 'native' }; });
  const engine = await manager.create({ direct: 'implement' });
  await engine.submit('Work');
  fail = false; await engine.retry();
  assert.deepEqual(engine.state.session.runs.map(run => run.status), ['failed', 'completed']);
  const saved = await readSession(manager.options.stateRoot, engine.state.session.id, root, true);
  saved.runs[1]!.status = 'running';
  const recovered = new Engine({ ...manager.options, profiles: engine.profiles, session: saved, directProfileId: 'implement' });
  assert.equal(recovered.state.session.runs[1]!.status, 'stopped');
  assert.match(recovered.state.session.runs[1]!.error!, /Previous process/);
}));

test('stdio accepts controls during execution, validates request IDs and redacts state', async () => temp(async root => {
  const input = new PassThrough(), output = new PassThrough();
  const messages: any[] = [];
  let buffer = '';
  output.setEncoding('utf8'); output.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
  const until = async (check: () => boolean) => { for (let n = 0; n < 500; n++) { if (check()) return; await delay(10); } assert.fail('Protocol response timed out.'); };
  let count = 0;
  const send = async (method: string, params: unknown = {}) => {
    const id = String(++count); input.write(JSON.stringify({ version: 1, id, method, params }) + '\n');
    await until(() => messages.some(m => m.id === id)); return messages.find(m => m.id === id);
  };
  const manager = managerFor(root, async run => {
    await run.ask('permission', 'Allow fixture?', 'No external operation.', run.signal);
    run.onEvent({ kind: 'session', text: '', sessionId: 'worker-native' });
    return await new Promise((_, reject) => run.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
  });
  process.env.SUBHARNESS_TEST_SECRET = 'protocol-private-value';
  const running = serveStdio(manager, input, output);
  try {
    const created = await send('session.create', { direct: 'implement' });
    assert.equal(created.ok, true); const sessionId = created.result.session.id;
    assert.equal((await send('session.submit', { sessionId, text: 'protocol-private-value' })).result.accepted, true);
    await until(() => Boolean(manager.active?.state.request));
    assert.equal((await send('session.create')).ok, false);
    assert.equal((await send('request.respond', { sessionId, requestId: '00000000-0000-4000-8000-000000000000', answer: 'yes' })).ok, false);
    const requestId = manager.active!.state.request!.id;
    assert.equal((await send('session.submit', { sessionId, text: 'yes' })).ok, false);
    assert.equal((await send('request.respond', { sessionId, requestId, answer: 'yes' })).ok, true);
    assert.equal((await send('request.respond', { sessionId, requestId, answer: 'yes' })).ok, false);
    await until(() => manager.active?.state.session.runs[0]?.nativeSessionId === 'worker-native');
    await send('session.stop', { sessionId });
    await until(() => !manager.active!.state.busy);
    const stopped = await send('session.get', { sessionId });
    assert.equal(stopped.result.status, 'stopped');
    assert.equal(stopped.result.session.runs[0].status, 'stopped');
    assert.doesNotMatch(JSON.stringify(messages), /protocol-private-value/);
    assert.equal((await send('session.list')).result.length, 1);
    const next = await send('session.create', { orchestrator: 'ui', workers: ['implement'] });
    assert.equal(next.ok, true);
    assert.equal((await send('session.stop', { sessionId })).ok, false);
    assert.equal((await send('session.open', { sessionId })).ok, true);
    assert.equal((await send('session.rename', { sessionId, title: 'กลับมาแล้ว' })).ok, true);
    input.write('not json\n');
    input.write('x'.repeat(65537)); input.write('\n');
    assert.equal((await send('session.get', { sessionId, unknown: true })).ok, false);
    assert.equal((await send('session.get', { sessionId })).result.session.title, 'กลับมาแล้ว');
    const bytes = Buffer.from(JSON.stringify({ version: 1, id: 'thai', method: 'session.rename', params: { sessionId, title: 'ภาษาไทย' } }) + '\n');
    for (const byte of bytes) input.write(Buffer.from([byte]));
    await until(() => messages.some(m => m.id === 'thai'));
    assert.equal((await send('session.get', { sessionId })).result.session.title, 'ภาษาไทย');
    await until(() => messages.some(m => m.event === 'session.state'));
    assert(messages.some(m => m.error?.includes('64 KiB')));
  } finally { input.end(); await running; output.destroy(); delete process.env.SUBHARNESS_TEST_SECRET; }
}));

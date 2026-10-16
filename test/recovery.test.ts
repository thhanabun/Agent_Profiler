import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { SessionManager } from '../src/application.js';
import { Engine, readSession, sessionSchema } from '../src/engine.js';
import { createProfile, loadProfile } from '../src/profiles.js';
import { acquireLock } from '../src/storage.js';

test('hard process crash recovers its stale lock, checkpoint and native reference; explicit retry preserves completed work', { timeout: 20000 }, async () => {
  const parent = path.resolve('.workerdeck/tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'hard-recovery-'));
  const cwd = path.join(root, 'project with spaces'), stateRoot = path.join(root, 'state');
  await mkdir(cwd); await writeFile(path.join(cwd, 'completed.txt'), 'COMPLETED_ONCE\n');
  const source = path.join(root, 'profiles/recover-worker'); await createProfile(source, 'recover-worker', 'codex');
  const profile = await loadProfile(source);
  const makeTask = (id: string, dependsOn: string[], status: 'completed' | 'pending') => ({ id, title: id, goal: id, profileId: 'recover-worker',
    reason: 'Recovery fixture', dependsOn, acceptance: ['Delivered'], status });
  const session = sessionSchema.parse({ version: 1, id: randomUUID(), cwd, demo: true, goal: 'Recovery fixture', title: 'Hard crash recovery', planCount: 1,
    summary: 'Seeded fixture plan', tasks: [makeTask('completed', [], 'completed'), makeTask('interrupted', ['completed'], 'pending'), makeTask('dependent', ['interrupted'], 'pending')],
    messages: [], nativeSessions: {}, diffs: { completed: 'EARLIER_DIFF' } });
  await new Engine({ cwd, stateRoot, profiles: [profile], demo: true, session }).flush();
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.resolve('test/fixtures/recovery-child.ts'), root], {
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '', stdout = '', release: (() => Promise<void>) | undefined;
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<void>(resolve => { child.once('close', () => resolve()); });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('exit', () => { if (!stdout.includes('CHECKPOINT_READY')) reject(new Error(stderr)); });
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('CHECKPOINT_READY')) resolve(); });
  });
  try {
    await ready;
    await assert.rejects(acquireLock(stateRoot), /Another WorkerDeck process/);
    child.kill('SIGKILL'); await exited;
    const checkpoint = await readSession(stateRoot, session.id, cwd, true);
    assert.equal(checkpoint.tasks[1]!.status, 'running'); assert.equal(checkpoint.inFlight!.text, 'CHECKPOINTED_PARTIAL_OUTPUT');
    release = await acquireLock(stateRoot);
    let calls = 0;
    const manager = new SessionManager({ cwd, stateRoot, store: path.join(root, 'images'), extraRoot: path.join(root, 'profiles'), demo: true,
      runner: async input => {
        calls++; assert.equal(input.sessionId, 'fixture-interrupted-thread');
        if (calls === 1) { assert.equal(await readFile(path.join(cwd, 'work.txt'), 'utf8'), 'PRESERVED_EDIT\n'); await writeFile(path.join(cwd, 'work.txt'), 'PRESERVED_EDIT\nRETRIED\n'); }
        return { text: 'Recovered', sessionId: 'fixture-interrupted-thread' };
      } });
    let engine = await manager.open(session.id);
    assert.equal(calls, 0); assert.equal(engine.state.status, 'stopped'); assert.match(engine.state.error!, /retry interrupted/);
    assert.equal(engine.state.request, undefined); assert.equal(engine.state.session.runs[0]!.status, 'stopped');
    assert.equal(engine.state.session.tasks[0]!.status, 'completed'); assert.equal(engine.state.session.tasks[2]!.status, 'pending');
    await assert.rejects(engine.resume(), /retry interrupted/); assert.equal(calls, 0);
    engine = await manager.open(session.id);
    assert.equal(engine.state.session.messages.filter(message => message.text.includes('Recovered partial output')).length, 1);
    await engine.retry('interrupted');
    assert.equal(calls, 2); assert(engine.state.session.tasks.every(task => task.status === 'completed'));
    assert.deepEqual(engine.state.session.runs.map(run => run.status), ['stopped', 'completed', 'completed']);
    assert.equal(engine.state.session.diffs.completed, 'EARLIER_DIFF');
    assert.equal(await readFile(path.join(cwd, 'completed.txt'), 'utf8'), 'COMPLETED_ONCE\n');
    assert.equal(await readFile(path.join(cwd, 'work.txt'), 'utf8'), 'PRESERVED_EDIT\nRETRIED\n');
    engine = await manager.open(session.id); assert.equal(engine.state.error, undefined); assert.equal(engine.state.status, 'idle');
    await manager.shutdown();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited; await release?.(); await rm(root, { recursive: true, force: true });
  }
});

test('new user direction supersedes interrupted work so historical failures do not block future resume', async () => {
  const parent = path.resolve('.workerdeck/tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'recovery-direction-'));
  try {
    const source = path.join(root, 'source'); await createProfile(source, 'planner', 'opencode');
    const profile = await loadProfile(source);
    const session = sessionSchema.parse({ version: 1, id: randomUUID(), cwd: root, demo: true, goal: 'Old goal', planCount: 1, summary: '',
      tasks: [{ id: 'old-task', title: 'Old', goal: 'Old', profileId: 'planner', reason: 'Old', acceptance: ['Delivered'], dependsOn: [], status: 'failed', error: 'Original failure' }],
      messages: [], nativeSessions: {}, diffs: {} });
    const engine = new Engine({ cwd: root, stateRoot: path.join(root, 'state'), profiles: [profile], session, demo: true, orchestratorProfileId: 'planner', workerProfileIds: [],
      runner: async () => ({ text: '', structured: { summary: 'New direction answered', tasks: [] }, sessionId: 'fixture-planner' }) });
    await assert.rejects(engine.resume(), /retry old-task/);
    await engine.submit('Explain the project instead.');
    assert.match(engine.state.session.tasks[0]!.error!, /^Superseded.*Original failure/);
    await engine.resume(); assert.equal(engine.state.error, undefined);
    await assert.rejects(engine.retry('old-task'), /Choose a failed or stopped task/);
    await engine.shutdown();
  } finally { await rm(root, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { exportBundle, importBundle, inspectArchive } from '../src/bundles.js';
import { Engine, listSessions, readSession, redact } from '../src/engine.js';
import { builtinRoot, loadProfile, loadProfiles, safePath, sourceFiles } from '../src/profiles.js';
import { validatePlan } from '../src/schema.js';
import { changedFiles, snapshot, taskDiff } from '../src/workspace.js';
import { forget, personalContext, readMemory, remember } from '../src/memory.js';
import { claudeCloudConfigured, getClaudeAuth } from '../src/auth.js';
import { inspectProfiles, type Runner } from '../src/adapters.js';

const plan = () => ({ summary: 'Implement, design, then integrate.', tasks: [
  { id: 'build', title: 'Build', goal: 'Implement the foundation', profileId: 'implement', reason: 'Implementation specialist', dependsOn: [], acceptance: ['Foundation delivered'] },
  { id: 'design', title: 'Design', goal: 'Refine the interface', profileId: 'ui', reason: 'UI specialist', dependsOn: ['build'], acceptance: ['UI delivered'] },
  { id: 'finish', title: 'Integrate', goal: 'Integrate both deliveries', profileId: 'implement', reason: 'Integration specialist', dependsOn: ['design'], acceptance: ['Integration delivered'] },
] });

async function temp<T>(work: (root: string) => Promise<T>): Promise<T> {
  const testRoot = path.join(process.cwd(), '.subharness', 'tests');
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(path.join(testRoot, 'case-'));
  try { return await work(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('planner validates profile choices, task IDs and dependency DAG', async () => {
  const profiles = await loadProfiles();
  assert.equal(validatePlan(plan(), profiles).tasks.length, 3);
  const cycle = plan(); cycle.tasks[0]!.dependsOn = ['finish'];
  assert.throws(() => validatePlan(cycle, profiles), /circular/);
  const unavailable = plan(); unavailable.tasks[1]!.profileId = 'invented';
  assert.throws(() => validatePlan(unavailable, profiles), /Unavailable/);
  const duplicate = plan(); duplicate.tasks[1]!.id = 'build';
  assert.throws(() => validatePlan(duplicate, profiles), /duplicate/);
  const missing = plan(); missing.tasks[0]!.dependsOn = ['nonexistent'];
  assert.throws(() => validatePlan(missing, profiles), /Unknown dependency/);
});

test('profile source includes declared skills and excludes sessions/credentials', async () => {
  const files = await sourceFiles(path.join(builtinRoot, 'ui'));
  assert.deepEqual(Object.keys(files).sort(), ['profile.json', 'skills/ui-craft/SKILL.md']);
  for (const value of ['../secret', '/absolute', 'C:/secret', 'skills\\..\\secret', '.env', 'sessions/one.json', 'keys/private.pem', 'skills/.credentials.json', 'skills/memory.json']) {
    assert.throws(() => safePath('/profile', value), /Unsafe/);
  }
});

test('bundle roundtrip preserves components, checksums and rejects overwrite/tampering', async () => temp(async root => {
  const bundle = path.join(root, 'designer.agentpack');
  const source = path.join(builtinRoot, 'ui');
  const expected = await exportBundle(source, bundle);
  const target = path.join(root, 'imported');
  assert.equal(await importBundle(bundle, target), expected);
  assert.equal((await loadProfile(target)).checksum, expected);
  assert.equal(await readFile(path.join(target, 'skills/ui-craft/SKILL.md'), 'utf8'), await readFile(path.join(source, 'skills/ui-craft/SKILL.md'), 'utf8'));
  await assert.rejects(importBundle(bundle, target), /already exists/);
  await assert.rejects(exportBundle(source, bundle), /EEXIST/);
  const files = unzipSync(new Uint8Array(await readFile(bundle)));
  files['skills/ui-craft/SKILL.md'] = Buffer.from('tampered');
  const corrupt = path.join(root, 'tampered.agentpack');
  await writeFile(corrupt, zipSync(files));
  await assert.rejects(importBundle(corrupt, path.join(root, 'corrupt')), /checksum/);
}));

test('archive inspection rejects traversal, symlinks, duplicates and expanded-size attacks', () => {
  const normal = { 'profile.json': Buffer.from('{}'), 'profile.lock.json': Buffer.from('{}') };
  assert.throws(() => inspectArchive(zipSync({ ...normal, '../escape': Buffer.from('x') })), /Unsafe/);
  assert.throws(() => inspectArchive(zipSync({ ...normal, 'SKILL.md': Buffer.from('a'), 'skill.md': Buffer.from('b') })), /Duplicate/);
  const symlink = Buffer.from(zipSync(normal));
  const central = symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  symlink.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38);
  assert.throws(() => inspectArchive(symlink), /symlink/);
  const bomb = Buffer.from(zipSync(normal));
  const entry = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(51 * 1024 * 1024, entry + 24);
  assert.throws(() => inspectArchive(bomb), /expanded/);
  assert.throws(() => inspectArchive(new Uint8Array(4)), /Invalid/);
});

test('engine routes automatically, respects dependencies, hands back context and resumes per-profile sessions', async () => temp(async root => {
  const profiles = await loadProfiles();
  const calls: Array<{ profile: string; prompt: string; session?: string }> = [];
  const runner: Runner = async input => {
    calls.push({ profile: input.profile.manifest.id, prompt: input.prompt, session: input.sessionId });
    if (input.schema) return { text: JSON.stringify(plan()), structured: plan(), sessionId: 'planner-native' };
    return { text: `Delivered by ${input.profile.manifest.id}`, sessionId: input.sessionId ?? `native-${input.profile.manifest.id}` };
  };
  const engine = new Engine({ cwd: root, stateRoot: path.join(root, 'state'), profiles, demo: true, runner });
  await engine.submit('Build a booking app');
  assert.equal(engine.state.error, undefined);
  assert.deepEqual(calls.map(call => call.profile), ['orchestrator', 'implement', 'ui', 'implement']);
  assert.equal(calls[3]!.session, 'native-implement');
  assert.match(calls[3]!.prompt, /Delivered by ui/);
  assert(engine.state.session.tasks.every(task => task.status === 'completed'));
  const saved = await readSession(path.join(root, 'state'), engine.state.session.id, root, true);
  assert.equal(saved.tasks.length, 3);
  await assert.rejects(readSession(path.join(root, 'state'), saved.id, root, false), /Simulated/);
}));

test('failed worker blocks dependent tasks; retry resumes the original work', async () => temp(async root => {
  let fail = true;
  const called: string[] = [];
  const runner: Runner = async input => {
    if (input.schema) return { text: '', structured: plan(), sessionId: 'plan' };
    called.push(input.profile.manifest.id);
    if (fail) throw new Error('Provider unavailable');
    return { text: 'Delivered', sessionId: input.profile.manifest.id };
  };
  const engine = new Engine({ cwd: root, stateRoot: path.join(root, 'state'), profiles: await loadProfiles(), demo: true, runner });
  await engine.submit('Build');
  assert.equal(engine.state.session.tasks[0]!.status, 'failed');
  assert.equal(engine.state.session.tasks[1]!.status, 'pending');
  assert.deepEqual(called, ['implement']);
  fail = false;
  await engine.retry();
  assert(engine.state.session.tasks.every(task => task.status === 'completed'));
}));

test('stopping active work preserves partial output and does not run dependents', async () => temp(async root => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const runner: Runner = async input => {
    if (input.schema) return { text: '', structured: plan(), sessionId: 'plan' };
    input.onEvent({ kind: 'text', text: 'Partial implementation' });
    started();
    return await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  };
  const engine = new Engine({ cwd: root, stateRoot: path.join(root, 'state'), profiles: await loadProfiles(), demo: true, runner });
  const pending = engine.submit('Build');
  await ready;
  engine.stop();
  await pending;
  assert.equal(engine.state.session.tasks[0]!.status, 'stopped');
  assert.equal(engine.state.session.tasks[1]!.status, 'pending');
  assert(engine.state.session.messages.some(message => message.text.includes('Partial implementation')));
}));

test('blocked reports fail the task instead of falsely completing the flow', async () => temp(async root => {
  const runner: Runner = async input => input.schema ? { text: '', structured: plan(), sessionId: 'p' }
    : { text: 'BLOCKED: Need access to the API', sessionId: 'w' };
  const engine = new Engine({ cwd: root, stateRoot: path.join(root, 'state'), profiles: await loadProfiles(), demo: true, runner });
  await engine.submit('Build');
  assert.equal(engine.state.session.tasks[0]!.status, 'failed');
  assert.equal(engine.state.session.tasks[1]!.status, 'pending');
}));

test('workspace change detection includes creates, edits and deletes', () => {
  assert.deepEqual(changedFiles({ a: '1', b: '2' }, { a: '3', c: '4' }).sort(), ['a', 'b', 'c']);
});

test('direction during a task causes automatic replanning at the next boundary', async () => temp(async root => {
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  let plans = 0;
  const runner: Runner = async input => {
    calls.push(input.profile.manifest.id);
    if (input.schema) {
      plans++;
      const next = plans === 1 ? plan() : { summary: 'Apply the new direction.', tasks: [{ ...plan().tasks[1]!, id: 'new-design', dependsOn: [] }] };
      if (plans === 2) { assert.match(input.prompt, /Make it dark/); assert.match(input.prompt, /Foundation delivered/); }
      return { text: '', structured: next, sessionId: 'planner' };
    }
    if (input.profile.manifest.id === 'implement') { started(); await gate; }
    return { text: 'Foundation delivered', sessionId: input.profile.manifest.id };
  };
  const engine = new Engine({ cwd: root, stateRoot: path.join(root, 'state'), profiles: await loadProfiles(), demo: true, runner });
  const running = engine.submit('Build a booking app');
  await ready;
  await engine.submit('Make it dark');
  release();
  await running;
  assert.deepEqual(calls, ['orchestrator', 'implement', 'orchestrator', 'ui']);
  assert.equal(engine.state.error, undefined);
  assert.equal(engine.state.session.tasks[1]!.error, 'Superseded by new direction.');
}));

test('denying live profile trust starts no harness', async () => temp(async root => {
  let calls = 0;
  const runner: Runner = async () => { calls++; return { text: '', structured: plan(), sessionId: 'planner' }; };
  const profiles = await loadProfiles();
  const engine = new Engine({ cwd: root, stateRoot: path.join(root, 'state'), profiles, runner,
    inspect: async () => Object.fromEntries(profiles.map(profile => [profile.manifest.id, { available: true, reason: 'Fixture' }])) });
  engine.on('change', () => { if (engine.state.request) engine.answer('no'); });
  await engine.submit('Build');
  assert.equal(calls, 0);
  assert.match(engine.state.error!, /not trusted/);
}));

test('terminal output strips escape sequences and known environment secrets', () => {
  process.env.SUBHARNESS_TEST_SECRET = 'test-super-private-value';
  try { assert.equal(redact('\x1b[31mtest-super-private-value\x1b[0m'), '[redacted]'); }
  finally { delete process.env.SUBHARNESS_TEST_SECRET; }
});

test('ordinary chat has no worker tasks and saved memory/persona reach the next harness turn', async () => temp(async root => {
  const stateRoot = path.join(root, 'state');
  await mkdir(stateRoot);
  await writeFile(path.join(stateRoot, 'PERSONA.md'), 'Answer in Thai.');
  const entry = await remember(stateRoot, 'Prefer local tools.');
  assert.equal((await remember(stateRoot, 'Prefer local tools.')).id, entry.id);
  let calls = 0;
  const runner: Runner = async input => {
    calls++;
    assert.match(input.prompt, /Answer in Thai/);
    assert.match(input.prompt, /Prefer local tools/);
    return { text: '', structured: { summary: 'Hello, how can I help?', tasks: [] }, sessionId: 'chat-session' };
  };
  const engine = new Engine({ cwd: root, stateRoot, profiles: await loadProfiles(), demo: true, runner });
  await engine.submit('Hello');
  assert.equal(calls, 1);
  assert.equal(engine.state.session.tasks.length, 0);
  assert.equal(engine.state.session.needsPlan, false);
  assert.equal(engine.state.error, undefined);
  assert.match(engine.state.session.messages.at(-1)!.text, /Hello, how can I help/);
  await forget(stateRoot, entry.id);
  assert.deepEqual(await readMemory(stateRoot), []);
  assert.doesNotMatch(await personalContext(stateRoot), /Prefer local tools/);
  await assert.rejects(remember(stateRoot, ''), /too_small/);
  await assert.rejects(forget(stateRoot, 'deadbeef'), /Unknown memory/);
  await writeFile(path.join(stateRoot, 'PERSONA.md'), 'x'.repeat(16001));
  await assert.rejects(personalContext(stateRoot), /16 KB/);
}));

test('failed planning can be retried without a worker task', async () => temp(async root => {
  let calls = 0;
  const runner: Runner = async () => {
    if (++calls === 1) throw new Error('Provider unavailable');
    return { text: '', structured: { summary: 'Recovered', tasks: [] }, sessionId: 'p' };
  };
  const engine = new Engine({ cwd: root, stateRoot: path.join(root, 'state'), profiles: await loadProfiles(), demo: true, runner });
  await engine.submit('Hello');
  assert.equal(engine.state.session.needsPlan, true);
  await engine.retry();
  assert.equal(engine.state.error, undefined);
  assert.equal(engine.state.session.needsPlan, false);
  assert.equal(calls, 2);
}));

test('checkpoint captures a native session before completion and recovers interrupted output', async () => temp(async root => {
  const stateRoot = path.join(root, 'state');
  const profiles = await loadProfiles();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const runner: Runner = async input => {
    if (input.schema) return { text: '', structured: { ...plan(), tasks: [plan().tasks[0]!] }, sessionId: 'p' };
    input.onEvent({ kind: 'text', text: 'Unfinished work' });
    input.onEvent({ kind: 'session', text: '', sessionId: 'native-before-completion' });
    started();
    return await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
  };
  const engine = new Engine({ cwd: root, stateRoot, profiles, demo: true, runner });
  const pending = engine.submit('Build');
  await ready;
  await engine.flush();
  const saved = await readSession(stateRoot, 'latest', root, true);
  assert.equal(saved.inFlight!.text, 'Unfinished work');
  assert(Object.values(saved.nativeSessions).some(item => item.sessionId === 'native-before-completion'));
  const recovered = new Engine({ cwd: root, stateRoot, profiles, demo: true, runner, session: saved });
  assert.equal(recovered.state.session.tasks[0]!.status, 'stopped');
  assert(recovered.state.session.messages.some(message => message.text.includes('Recovered partial output')));
  engine.stop(); await pending;
  assert.equal((await listSessions(stateRoot, root)).length, 1);
  await assert.rejects(readSession(stateRoot, '../escape', root, true), /UUID/);
  saved.id = '00000000-0000-4000-8000-000000000000';
  await writeFile(path.join(stateRoot, 'sessions', `${engine.state.session.id}.json`), JSON.stringify(saved));
  await assert.rejects(readSession(stateRoot, engine.state.session.id, root, true), /does not match/);
}));

test('task diffs include new files and exclude earlier task edits to the same file', async () => temp(async root => {
  const stateRoot = path.join(root, 'custom-state');
  await mkdir(stateRoot);
  await writeFile(path.join(stateRoot, 'memory.json'), 'LOCAL_STATE_MUST_NOT_APPEAR');
  await writeFile(path.join(root, '.env'), 'MUST_NOT_CAPTURE=secret');
  const initial = await snapshot(root, stateRoot);
  assert.equal(initial.hashes['custom-state/memory.json'], undefined);
  await writeFile(path.join(root, 'new file.txt'), 'first task\n');
  const middle = await snapshot(root, stateRoot);
  assert.deepEqual(changedFiles(initial.hashes, middle.hashes), ['new file.txt']);
  assert.match(await taskDiff(root, ['new file.txt'], initial, middle, stateRoot), /\+first task/);
  await writeFile(path.join(root, 'new file.txt'), 'second task\n');
  const after = await snapshot(root, stateRoot);
  const diff = await taskDiff(root, ['new file.txt'], middle, after, stateRoot);
  assert.match(diff, /-first task/);
  assert.match(diff, /\+second task/);
  assert.doesNotMatch(diff, /\+first task/);
  assert.equal(after.hashes['.env'], undefined);
  await rm(path.join(root, 'new file.txt'));
  const deleted = await snapshot(root, stateRoot);
  assert.match(await taskDiff(root, ['new file.txt'], after, deleted, stateRoot), /\+\+\+ \/dev\/null/);
}));

test('session checkpoints redact known secrets in goals and task metadata', async () => temp(async root => {
  process.env.SUBHARNESS_TEST_SECRET = 'test-secret-must-not-save';
  try {
    const engine = new Engine({ cwd: root, stateRoot: path.join(root, 'state'), profiles: await loadProfiles(), demo: true,
      runner: async () => ({ text: '', structured: { summary: 'test-secret-must-not-save', tasks: [] }, sessionId: 'p' }) });
    await engine.submit('Remember test-secret-must-not-save');
    const file = await readFile(path.join(root, 'state', 'sessions', `${engine.state.session.id}.json`), 'utf8');
    assert.doesNotMatch(file, /test-secret-must-not-save/);
    assert.match(file, /redacted/);
  } finally { delete process.env.SUBHARNESS_TEST_SECRET; }
}));

test('direction sent during a chat-only planning response is saved and processed', async () => temp(async root => {
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let plans = 0;
  const runner: Runner = async input => {
    plans++;
    if (plans === 1) { started(); await gate; }
    else assert.match(input.prompt, /Actually, explain profiles/);
    return { text: '', structured: { summary: `Answer ${plans}`, tasks: [] }, sessionId: 'p' };
  };
  const stateRoot = path.join(root, 'state');
  const engine = new Engine({ cwd: root, stateRoot, profiles: await loadProfiles(), demo: true, runner });
  const pending = engine.submit('Hello');
  await ready;
  await engine.submit('Actually, explain profiles');
  const saved = await readSession(stateRoot, engine.state.session.id, root, true);
  assert.deepEqual(saved.steering, ['Actually, explain profiles']);
  release(); await pending;
  assert.equal(plans, 2);
  assert.equal(engine.state.error, undefined);
  assert.deepEqual(engine.state.session.steering, []);
}));

test('Claude readiness accepts local API/cloud configuration without exposing a key', async () => {
  const keys = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'SUBHARNESS_CLAUDE_BIN'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.ANTHROPIC_API_KEY = 'fixture-not-a-real-key';
    const api = await getClaudeAuth();
    assert.equal(api.method, 'api-key');
    assert.equal(api.available, true);
    assert.doesNotMatch(api.reason, /fixture-not-a-real-key/);
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_USE_BEDROCK = '0';
    assert.equal(claudeCloudConfigured(), false);
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    assert.equal((await getClaudeAuth()).method, 'cloud');
    process.env.SUBHARNESS_CLAUDE_BIN = path.resolve('.subharness', 'missing-native-claude-fixture.exe');
    const readiness = await inspectProfiles(await loadProfiles());
    assert.equal(readiness.ui!.available, false);
    assert.match(readiness.ui!.reason, /not found/);
    assert(readiness.implement);
  } finally {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});

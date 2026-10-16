import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectProfiles } from '../src/adapters.js';
import { SessionManager } from '../src/application.js';
import { serveStdio } from '../src/protocol.js';
import { createProfile, loadProfile, loadProfiles } from '../src/profiles.js';

async function temp(work: (root: string) => Promise<void>) {
  const parent = path.resolve('.workerdeck/tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'readiness-'));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('readiness reports missing environment, native setup, unsupported plugins and image platform without model calls', async () => {
  const keys = ['WORKERDECK_CODEX_BIN', 'WORKERDECK_OPENCODE_BIN', 'WORKERDECK_FIXTURE_REQUIRED'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.WORKERDECK_CODEX_BIN = path.resolve('.workerdeck/missing-readiness-codex.exe');
    process.env.WORKERDECK_OPENCODE_BIN = path.resolve('.workerdeck/missing-readiness-opencode.exe');
    delete process.env.WORKERDECK_FIXTURE_REQUIRED;
    const profiles = await loadProfiles();
    const codex = structuredClone(profiles.find(profile => profile.manifest.id === 'codex')!);
    codex.manifest.requiredEnv = ['WORKERDECK_FIXTURE_REQUIRED'];
    codex.manifest.plugins = ['plugins/example'];
    codex.image = { digest: `sha256:${'a'.repeat(64)}`, runtimeVersion: '1.0.0', adapterVersion: '0.1.0', platform: 'unsupported-fixture', arch: process.arch };
    const result = await inspectProfiles([codex, profiles.find(profile => profile.manifest.id === 'implement')!]);
    assert.equal(result.codex!.available, false);
    for (const kind of ['environment', 'plugins', 'native', 'image']) {
      const check = result.codex!.checks!.find(check => check.kind === kind)!;
      assert.equal(check.status, 'blocked'); assert(check.action);
    }
    assert.match(result.codex!.checks!.find(check => check.kind === 'environment')!.reason, /WORKERDECK_FIXTURE_REQUIRED/);
    assert.match(result.codex!.checks!.find(check => check.kind === 'image')!.reason, /unsupported-fixture/);
    assert.equal(result.codex!.checks!.find(check => check.kind === 'provider')!.status, 'unverified');
    assert.equal(result.implement!.available, false);
    assert.match(result.implement!.checks!.find(check => check.kind === 'native')!.action!, /WORKERDECK_OPENCODE_BIN/);
    process.env.WORKERDECK_FIXTURE_REQUIRED = 'fixture-value-must-never-appear';
    const configured = await inspectProfiles([codex]);
    assert.equal(configured.codex!.checks!.find(check => check.kind === 'environment')!.status, 'passed');
    assert.doesNotMatch(JSON.stringify(configured), /fixture-value-must-never-appear/);
  } finally {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});

test('readiness validates skill source and resolves model overrides without creating a session', async () => temp(async root => {
  let inspected = 0;
  const manager = new SessionManager({ cwd: root, stateRoot: path.join(root, 'state'), store: path.join(root, 'images'), extraRoot: path.join(root, 'profiles'),
    inspect: async profiles => { inspected++; return Object.fromEntries(profiles.map(profile => [profile.manifest.id, {
      available: true, reason: 'Fixture setup passed.', checks: [{ kind: 'provider' as const, status: 'unverified' as const, reason: 'No model request.' }],
    }])); } });
  const source = path.join(root, 'profile with spaces');
  await createProfile(source, 'ready-fixture', 'codex');
  const key = 'WORKERDECK_MODEL_READY_FIXTURE', saved = process.env[key];
  try {
    process.env[key] = 'fixture-model-override';
    const ready = await manager.readiness(source);
    assert.equal(ready.available, true); assert.equal(ready.model, 'fixture-model-override');
    assert.equal(ready.profileId, 'ready-fixture'); assert.equal(ready.harness, 'codex');
    assert.match(ready.checksum!, /^[a-f0-9]{64}$/); assert(Number.isFinite(Date.parse(ready.checkedAt)));
    assert.equal(ready.checks[0]!.kind, 'source'); assert.equal(inspected, 1);
    await rm(path.join(source, 'skills/working-notes/SKILL.md'));
    const missing = await manager.readiness(source);
    assert.equal(missing.available, false); assert.equal(missing.checks[0]!.kind, 'source');
    assert.match(missing.reason, /SKILL.md/); assert(missing.checks[0]!.action); assert.equal(inspected, 1);
    assert.equal(manager.active, undefined); assert.deepEqual(await manager.list(), []);
  } finally { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; await manager.shutdown(); }
}));

test('stdio readiness replies independently so slow preflight does not block stop or approval controls', async () => temp(async root => {
  let release!: () => void, inspecting = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const manager = new SessionManager({ cwd: root, stateRoot: path.join(root, 'state'), store: path.join(root, 'images'), extraRoot: path.join(root, 'profiles'), demo: true,
    inspect: async profiles => { inspecting = true; await gate; return Object.fromEntries(profiles.map(profile => [profile.manifest.id, { available: true, reason: 'Fixture' }])); },
    runner: async run => { await run.ask('permission', 'Fixture approval', 'No operation will execute.', run.signal); return { text: 'Done', sessionId: 'fixture-native' }; } });
  const input = new PassThrough(), output = new PassThrough(), messages: any[] = [];
  let buffer = '';
  output.setEncoding('utf8'); output.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
  const until = async (check: () => boolean) => { for (let n = 0; n < 500; n++) { if (check()) return; await delay(10); } assert.fail('Protocol timed out.'); };
  const send = async (id: string, method: string, params: unknown) => {
    input.write(JSON.stringify({ version: 1, id, method, params }) + '\n');
    await until(() => messages.some(message => message.id === id)); return messages.find(message => message.id === id);
  };
  const running = serveStdio(manager, input, output);
  try {
    assert(messages[0].methods.includes('profiles.readiness'));
    const bad = await send('bad', 'profiles.readiness', { reference: 'codex', extra: true }); assert.equal(bad.ok, false);
    const created = await send('create', 'session.create', { direct: 'codex' }); const sessionId = created.result.session.id;
    await send('submit', 'session.submit', { sessionId, text: 'Fixture' }); await until(() => Boolean(manager.active?.state.request));
    input.write(JSON.stringify({ version: 1, id: 'preflight', method: 'profiles.readiness', params: { reference: 'codex' } }) + '\n');
    await until(() => inspecting);
    assert(!messages.some(message => message.id === 'preflight'));
    const answer = await send('answer', 'request.respond', { sessionId, requestId: manager.active!.state.request!.id, answer: 'no' });
    assert.equal(answer.ok, true);
    assert.equal((await send('stop', 'session.stop', { sessionId })).ok, true);
    assert(!messages.some(message => message.id === 'preflight'));
    release(); await until(() => messages.some(message => message.id === 'preflight'));
    const ready = messages.find(message => message.id === 'preflight');
    assert.equal(ready.ok, true); assert.equal(ready.result.reference, 'codex'); assert.equal(ready.result.available, true);
    await until(() => !manager.active!.state.busy);
    assert.equal((await manager.list()).length, 1);
    assert.equal((await loadProfile(path.resolve('profiles/codex'))).checksum, ready.result.checksum);
  } finally { release(); input.end(); await running; output.destroy(); }
}));

test('CLI check --json returns actionable setup errors and a nonzero exit code without starting a session', async () => temp(async root => {
  const source = path.join(root, 'profile with spaces');
  await createProfile(source, 'cli-ready-fixture', 'opencode');
  const child = spawn(process.execPath, [path.resolve('bin/workerdeck.mjs'), 'check', source, '--json', '--cwd', root, '--store', path.join(root, 'images')], {
    env: { ...process.env, WORKERDECK_OPENCODE_BIN: path.join(root, 'missing-native-opencode') }, windowsHide: true, shell: false, timeout: 15000,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 1, stderr);
  const report = JSON.parse(stdout);
  assert.equal(report.reference, source); assert.equal(report.profileId, 'cli-ready-fixture'); assert.equal(report.available, false);
  assert(report.checks.some((check: any) => check.kind === 'native' && check.action.includes('WORKERDECK_OPENCODE_BIN')));
  const manager = new SessionManager({ cwd: root, stateRoot: path.join(root, '.workerdeck'), store: path.join(root, 'images'), extraRoot: path.join(root, 'profiles') });
  assert.deepEqual(await manager.list(), []);
}));

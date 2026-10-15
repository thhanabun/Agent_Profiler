import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Engine, readSession, sessionSchema } from '../src/engine.js';
import { createProfile, loadProfile } from '../src/profiles.js';
import { acquireLock } from '../src/storage.js';
import { SessionManager } from '../src/application.js';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
async function descendants(pid: number): Promise<number[]> {
  // This live suite is Windows-specific; never print unrelated process metadata.
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { windowsHide: true });
  const rows = JSON.parse(stdout) as Array<{ ProcessId: number; ParentProcessId: number }>;
  const owned = new Set([pid]); let count = 0;
  while (count !== owned.size) { count = owned.size; for (const row of rows) if (owned.has(row.ParentProcessId)) owned.add(row.ProcessId); }
  return [...owned].filter(value => value !== pid);
}

for (const harness of ['opencode', 'codex'] as const) test(`real ${harness}: hard-kill CLI, reopen without execution, retry native session once`, {
  skip: process.env.SUBHARNESS_TEST_RECOVERY_LIVE !== '1' || process.platform !== 'win32', timeout: 240000,
}, async context => {
  const parent = path.resolve('.subharness/recovery'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, `${harness}-`)), cwd = path.join(root, 'project with spaces'), stateRoot = path.join(root, 'state');
  await mkdir(cwd); await promisify(execFile)('git', ['init', '--quiet'], { cwd, windowsHide: true });
  const source = path.join(root, 'profiles/worker'); await createProfile(source, 'recovery-worker', harness);
  const manifest = JSON.parse(await readFile(path.join(source, 'profile.json'), 'utf8'));
  manifest.model = harness === 'opencode' ? process.env.SUBHARNESS_TEST_OPENCODE_MODEL ?? 'opencode/muse-spark-1.3-contributor-free' : process.env.SUBHARNESS_TEST_CODEX_MODEL ?? 'gpt-6.1-sol';
  manifest.skills = []; manifest.instructions = 'Authorized isolated recovery test. Follow YOUR TASK. Do not use tools, edit files, call integrations or spawn subagents. If shared conversation contains a system message beginning Recovered partial output, return exactly RECOVERY_OK instead of repeating the long response.';
  await writeFile(path.join(source, 'profile.json'), JSON.stringify(manifest));
  await writeFile(path.join(cwd, 'completed.txt'), 'PRESERVE_COMPLETED\n');
  const profile = await loadProfile(source);
  const task = (id: string, status: 'pending' | 'completed', dependsOn: string[], goal: string) => ({ id, title: id, profileId: profile.manifest.id, status, dependsOn, goal, reason: 'Recovery fixture', acceptance: ['Deliver the requested text.'] });
  const session = sessionSchema.parse({ version: 1, id: randomUUID(), cwd, demo: false, title: 'Live hard crash recovery', goal: 'Follow each assigned task in this recovery test.',
    planCount: 1, summary: 'Seeded plan with a completed prerequisite; live worker calls only.', tasks: [task('completed', 'completed', [], 'Previously delivered'),
      task('interrupted', 'pending', ['completed'], 'Without tools, write 500 numbered lines about a greeting function. Keep streaming until all lines are complete.'),
      task('dependent', 'pending', ['interrupted'], 'Return exactly RECOVERY_OK without tools.')], messages: [], nativeSessions: {}, diffs: { completed: 'PRESERVED_DIFF' } });
  await new Engine({ cwd, stateRoot, profiles: [profile], session }).flush();
  await writeFile(path.join(stateRoot, 'trust.json'), JSON.stringify([profile.checksum])); // Exact generated source only.
  const child = spawn(process.execPath, [path.resolve('bin/subharness.mjs'), 'serve', '--stdio', '--cwd', cwd, '--state-dir', stateRoot, '--store', path.join(root, 'images'), '--profiles', path.join(root, 'profiles')], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages: any[] = []; let buffer = '', stderr = '', owned: number[] = [], passed = false, cleanupOwned = true;
  const exited = new Promise<void>(resolve => { child.once('close', () => resolve()); });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const until = async (condition: () => boolean | Promise<boolean>, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { context.signal.throwIfAborted(); if (await condition()) return; await delay(100); }
    throw new Error(`Live recovery timed out. ${stderr}`);
  };
  const send = async (id: string, method: string, params: unknown) => {
    child.stdin.write(JSON.stringify({ version: 1, id, method, params }) + '\n'); await until(() => messages.some(message => message.id === id));
    const response = messages.find(message => message.id === id); assert.equal(response.ok, true, response.error); return response.result;
  };
  let release: (() => Promise<void>) | undefined, manager: SessionManager | undefined;
  const abort = () => { child.kill('SIGKILL'); void manager?.shutdown(); }; context.signal.addEventListener('abort', abort, { once: true });
  console.log(`Live recovery artifacts: ${root}`);
  try {
    await send('open', 'session.open', { sessionId: session.id }); await send('run', 'session.resume', { sessionId: session.id });
    await until(async () => {
      const saved = await readSession(stateRoot, session.id, cwd, false);
      return Boolean(saved.inFlight && saved.inFlight.text.length > 32 && saved.runs[0]?.status === 'running' && saved.runs[0].nativeSessionId);
    });
    owned = await descendants(child.pid!); assert(owned.length > 0);
    child.kill('SIGKILL'); await exited;
    await until(() => owned.every(pid => !alive(pid)), 10000);
    cleanupOwned = false; // Do not signal old PIDs after they have exited and may be reused.
    const crashed = await readSession(stateRoot, session.id, cwd, false);
    assert.equal(crashed.tasks[1]!.status, 'running'); assert(crashed.inFlight!.text);
    const originalNative = crashed.runs[0]!.nativeSessionId;
    release = await acquireLock(stateRoot);
    manager = new SessionManager({ cwd, stateRoot, store: path.join(root, 'images'), extraRoot: path.join(root, 'profiles') });
    const engine = await manager.open(session.id);
    assert.equal(engine.state.busy, false); assert.equal(engine.state.status, 'stopped'); assert.equal(engine.state.session.runs.length, 1);
    assert.equal(engine.state.session.tasks[0]!.status, 'completed'); assert.equal(engine.state.session.tasks[1]!.status, 'stopped');
    await assert.rejects(engine.resume(), /retry interrupted/);
    engine.on('change', () => { if (engine.state.request) engine.answer('no', engine.state.request.id); });
    await engine.retry('interrupted');
    assert.equal(engine.state.error, undefined); assert(engine.state.session.tasks.every(item => item.status === 'completed'));
    assert.equal(engine.state.session.tasks[1]!.result!.trim(), 'RECOVERY_OK');
    assert.equal(engine.state.session.tasks[2]!.result!.trim(), 'RECOVERY_OK');
    assert.deepEqual(engine.state.session.runs.map(run => run.status), ['stopped', 'completed', 'completed']);
    assert(engine.state.session.runs.every(run => run.nativeSessionId === originalNative));
    assert.equal(engine.state.session.messages.filter(message => message.text.startsWith('Recovered partial output')).length, 1);
    assert.equal(await readFile(path.join(cwd, 'completed.txt'), 'utf8'), 'PRESERVE_COMPLETED\n'); assert.equal(engine.state.session.diffs.completed, 'PRESERVED_DIFF');
    await writeFile(path.join(root, 'recovered-session.json'), JSON.stringify(engine.state.session, null, 2)); passed = true;
  } finally {
    context.signal.removeEventListener('abort', abort); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (cleanupOwned) for (const pid of [...owned].reverse()) { try { process.kill(pid, 'SIGKILL'); } catch { /* Only tracked fixture descendants. */ } }
    await manager?.shutdown(); await release?.();
    await writeFile(path.join(root, 'result.json'), JSON.stringify({ passed, harness, model: manifest.model, sessionId: session.id, owned, stderr }, null, 2));
    console.log(JSON.stringify({ passed, harness, artifacts: root }));
  }
});

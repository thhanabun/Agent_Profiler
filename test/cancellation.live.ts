// Opt-in real model checks; excluded from npm test. Artifacts stay in .workerdeck/cancellation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { modelFor, nativeRuntime, runOpenCode, type HarnessEvent } from '../src/adapters.js';
import { runCodex } from '../src/codex.js';
import { Engine, readSession, sessionSchema } from '../src/engine.js';
import { createProfile, loadProfile } from '../src/profiles.js';
import { stopProcess } from '../src/process.js';

for (const harness of ['opencode', 'codex'] as const) for (const phase of ['streaming', 'permission', 'tool'] as const) {
  test(`real ${harness}: stop while ${phase}, terminate native process and block dependent work`, {
    skip: process.env.WORKERDECK_TEST_CANCEL_LIVE !== '1', timeout: 150000,
  }, async context => {
    const parent = path.resolve('.workerdeck/cancellation'); await mkdir(parent, { recursive: true });
    const root = await mkdtemp(path.join(parent, `${harness}-${phase}-`));
    const cwd = path.join(root, 'project with spaces'), stateRoot = path.join(root, 'state'), source = path.join(root, 'profile');
    await mkdir(cwd); await promisify(execFile)('git', ['init', '--quiet'], { cwd, windowsHide: true });
    await createProfile(source, `cancel-${harness}`, harness);
    const manifest = JSON.parse(await readFile(path.join(source, 'profile.json'), 'utf8'));
    manifest.model = harness === 'opencode' ? process.env.WORKERDECK_TEST_OPENCODE_MODEL ?? 'opencode/muse-spark-1.3-contributor-free'
      : process.env.WORKERDECK_TEST_CODEX_MODEL ?? 'gpt-6.1-sol';
    manifest.instructions = 'This is an authorized cancellation test in an isolated fixture. Follow only the exact task. Do not edit files, use integrations/network tools, spawn subagents, or commit/publish anything. A controller will stop the task.';
    manifest.skills = [];
    await writeFile(path.join(source, 'profile.json'), JSON.stringify(manifest, null, 2));
    // Request shell approval; only the exact long-tool fixture may be approved below.
    if (harness === 'opencode') await writeFile(path.join(cwd, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: {
      '*': 'deny', bash: 'ask', read: 'allow', skill: 'allow',
    } }));
    await writeFile(path.join(cwd, 'untouched.txt'), 'ORIGINAL\n');
    if (phase === 'tool') await writeFile(path.join(cwd, 'long-tool.cjs'), `const fs = require('node:fs');
const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
fs.writeFileSync('tool-started.json', JSON.stringify({ pid: process.pid, childPid: child.pid }));
setTimeout(() => { fs.writeFileSync('tool-finished.txt', 'SHOULD_NOT_FINISH'); process.exit(0); }, 60000);
`);
    const profile = await loadProfile(source), runtime = await nativeRuntime(harness);
    const taskId = 'cancel-target', dependentId = 'must-not-run';
    const goal = phase === 'streaming'
      ? 'Without using any tools, output exactly 250 numbered lines explaining a simple greeting function. Each line starts with CANCEL_STREAM_ and its line number. No introduction. Keep generating all lines; the test controller will interrupt you.'
      : phase === 'tool' ? 'Run exactly node long-tool.cjs with your native shell tool in the current project. This is an authorized fixture that starts a sleeping child and writes only local test markers. Request permission when required. Do not read/edit the script, run another command, or use another tool. The controller will stop you while it is running.'
      : 'Use your native shell tool to run exactly this harmless command in the current project: node -e "process.stdout.write(\'CANCEL_PERMISSION_PROBE\')". It only prints a marker. Request native approval if required. Do not substitute a written explanation, use another command/tool, or change any files. This is an authorized approval-cancellation test; the controller will stop before approval.';
    const session = sessionSchema.parse({ version: 1, id: randomUUID(), cwd, demo: false, goal, title: `Live ${harness} ${phase} cancellation`,
      planCount: 1, summary: 'Seeded deterministic plan; worker execution is real, no planner model call.', needsPlan: false,
      tasks: [
        { id: taskId, title: 'Cancellation target', goal, profileId: profile.manifest.id, reason: 'Exercise native cancellation.', dependsOn: [], acceptance: ['Return the requested output.'], status: 'pending' },
        { id: dependentId, title: 'Must remain pending', goal: 'Return CANCEL_DEPENDENT_SHOULD_NOT_RUN without tools.', profileId: profile.manifest.id,
          reason: 'Must not run after the prerequisite is stopped.', dependsOn: [taskId], acceptance: ['Return a final response.'], status: 'pending' },
      ], messages: [], nativeSessions: {}, diffs: {},
    });
    const children: ChildProcess[] = [], exits: Array<{ pid?: number; code: number | null; signal: string | null }> = [];
    const launch = ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args); children.push(child);
      child.once('exit', (code, signal) => { exits.push({ pid: child.pid, code, signal }); });
      return child;
    }) as typeof spawn;
    const events: Array<HarnessEvent & { at: string }> = [];
    let stopAt = 0, stoppedFor = '', requestId: string | undefined, unexpectedRequest = '';
    let toolPids: number[] = [], approved = 0, cleanupTools = true;
    let engine!: Engine;
    const stop = (reason: string) => {
      if (stopAt) return;
      stopAt = performance.now(); stoppedFor = reason;
      console.log(`${harness}/${phase}: stop at ${reason}`); engine.stop();
    };
    engine = new Engine({ cwd, stateRoot, profiles: [profile], session, workerProfileIds: [profile.manifest.id],
      runner: input => {
        const onEvent = (event: HarnessEvent) => {
          events.push({ ...event, at: new Date().toISOString() }); input.onEvent(event);
          if (phase === 'streaming' && event.kind === 'text' && event.text.trim()) stop('real streamed text');
        };
        return harness === 'opencode' ? runOpenCode({ ...input, onEvent }, launch) : runCodex({ ...input, onEvent }, modelFor(profile), launch);
      },
    });
    engine.on('change', () => {
      const request = engine.state.request;
      if (!request) return;
      if (request.kind === 'trust') { engine.answer('yes', request.id); return; } // Only the exact fixture source above is loaded.
      if (phase === 'tool' && request.kind === 'permission') {
        let safe = request.title === 'bash' && request.detail.trim() === 'node long-tool.cjs';
        try {
          const params = JSON.parse(request.detail);
          safe = request.title === 'Codex · item/commandExecution/requestApproval' && path.resolve(params.cwd) === cwd &&
            Array.isArray(params.commandActions) && params.commandActions.length === 1 && params.commandActions[0].command === 'node long-tool.cjs';
        } catch { /* OpenCode provides a plain command pattern. */ }
        if (safe) { approved++; engine.answer('yes', request.id); return; }
      }
      if (phase === 'permission' && request.kind === 'permission') { requestId = request.id; stop('native permission pending'); }
      else { unexpectedRequest = `${request.kind}: ${request.title}`; stop('unexpected native request'); }
    });
    const abort = () => engine.stop(); context.signal.addEventListener('abort', abort, { once: true });
    let checkingTool = false;
    const monitor = phase === 'tool' ? setInterval(() => {
      if (checkingTool || stopAt) return;
      checkingTool = true;
      void readFile(path.join(cwd, 'tool-started.json'), 'utf8').then(text => {
        const started = JSON.parse(text);
        assert(Number.isSafeInteger(started.pid) && Number.isSafeInteger(started.childPid));
        toolPids = [started.pid, started.childPid]; stop('approved tool running');
      }).catch(error => { if (error.code !== 'ENOENT') { unexpectedRequest = String(error); stop('tool observation failed'); } }).finally(() => { checkingTool = false; });
    }, 50) : undefined;
    let passed = false, stopMs: number | undefined;
    console.log(`Live cancellation artifacts: ${root}`);
    try {
      await engine.resume();
      stopMs = stopAt ? performance.now() - stopAt : undefined;
      assert.equal(unexpectedRequest, '');
      assert.equal(stoppedFor, phase === 'streaming' ? 'real streamed text' : phase === 'tool' ? 'approved tool running' : 'native permission pending', `Target phase was not reached: ${engine.state.error ?? engine.state.output}`);
      assert(stopMs! < 15000, `Stop took ${stopMs} ms.`);
      assert.equal(engine.state.busy, false); assert.equal(engine.state.status, 'stopped'); assert.equal(engine.state.request, undefined);
      assert.equal(engine.state.session.tasks[0]!.status, 'stopped'); assert.equal(engine.state.session.tasks[1]!.status, 'pending');
      assert.deepEqual(engine.state.session.tasks[0]!.changedFiles, phase === 'tool' ? ['tool-started.json'] : [], 'Unexpected fixture edits.');
      assert.equal(engine.state.session.runs.length, 1); assert.equal(engine.state.session.runs[0]!.status, 'stopped');
      assert(engine.state.session.runs[0]!.nativeSessionId); assert(engine.state.session.runs[0]!.endedAt);
      if (phase === 'streaming') assert(engine.state.session.messages.some(message => /Partial output/.test(message.text)));
      if (requestId) assert.throws(() => engine.answer('yes', requestId), /no longer active/);
      assert.equal(children.length, 1); assert.equal(exits.length, children.length, 'Native process did not exit before the engine became idle.');
      for (const child of children) {
        assert(child.exitCode !== null || child.signalCode !== null);
        assert.throws(() => process.kill(child.pid!, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH', 'Native PID is still alive.');
      }
      for (const pid of toolPids) assert.throws(() => process.kill(pid, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH', 'Tool descendant is still alive.');
      cleanupTools = false;
      await delay(250);
      const saved = await readSession(stateRoot, session.id, cwd, false);
      assert.equal(saved.tasks[0]!.status, 'stopped'); assert.equal(saved.tasks[1]!.status, 'pending');
      assert.equal(saved.runs.length, 1); assert.equal(saved.runs[0]!.status, 'stopped');
      assert.equal((await readFile(path.join(cwd, 'untouched.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'ORIGINAL\n');
      passed = true;
    } finally {
      clearInterval(monitor); context.signal.removeEventListener('abort', abort); await engine.shutdown();
      for (const child of children) await stopProcess(child);
      if (cleanupTools) for (const pid of toolPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* Only known fixture descendants. */ } }
      await writeFile(path.join(root, 'result.json'), JSON.stringify({ passed, harness, phase, model: manifest.model, runtime, sessionId: session.id,
        stoppedFor, stopMs, unexpectedRequest, requestId, approved, toolPids, exits, tasks: engine.state.session.tasks, runs: engine.state.session.runs,
        status: engine.state.status, error: engine.state.error, events }, null, 2));
      console.log(JSON.stringify({ passed, harness, phase, stoppedFor, stopMs, artifacts: root }));
    }
  });
}

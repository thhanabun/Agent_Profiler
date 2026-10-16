import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SessionManager } from '../src/application.js';
import { runNative } from '../src/adapters.js';
import { builtinRoot, forkProfile, loadProfile } from '../src/profiles.js';
import { Engine } from '../src/engine.js';

test('real OpenCode → Codex → OpenCode handoff, saved resume and Codex planning', { skip: process.env.WORKERDECK_TEST_LIVE !== '1', timeout: 360000 }, async context => {
  const parent = path.resolve('.workerdeck/cross-harness'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'live-'));
  const cwd = path.join(root, 'project with spaces'), stateRoot = path.join(root, 'state');
  await mkdir(cwd);
  const sources = [
    { source: 'orchestrator', id: 'live-planner', model: process.env.WORKERDECK_TEST_OPENCODE_MODEL ?? 'opencode/muse-spark-1.3-contributor-free' },
    { source: 'implement', id: 'live-opencode', model: process.env.WORKERDECK_TEST_OPENCODE_MODEL ?? 'opencode/muse-spark-1.3-contributor-free' },
    { source: 'codex', id: 'live-codex', model: process.env.WORKERDECK_TEST_CODEX_MODEL ?? 'gpt-6.1-sol' },
  ];
  for (const source of sources) {
    const destination = path.join(root, 'profiles', source.id);
    await forkProfile(await loadProfile(path.join(builtinRoot, source.source)), destination, source.id);
    const manifest = JSON.parse(await readFile(path.join(destination, 'profile.json'), 'utf8'));
    manifest.model = source.model;
    await writeFile(path.join(destination, 'profile.json'), JSON.stringify(manifest, null, 2));
  }
  const events: Array<{ profile: string; kind: string; text: string }> = [];
  const manager = new SessionManager({ cwd, stateRoot, store: path.join(root, 'images'), extraRoot: path.join(root, 'profiles'),
    runner: input => runNative({ ...input, onEvent: event => { input.onEvent(event); if (event.kind !== 'text') { events.push({ profile: input.profile.manifest.id, kind: event.kind, text: event.text }); console.log(`${input.profile.manifest.id}: ${event.kind} ${event.text.slice(0, 220)}`); } } }) });
  const attach = (engine: Engine) => {
    engine.on('change', () => {
      const request = engine.state.request;
      if (!request) return;
      if (request.kind === 'trust') { engine.answer('yes', request.id); return; } // Only the fixture sources created above are loaded.
      let safeRead = false, safeEdit = false;
      try {
        const params = JSON.parse(request.detail);
        const actions = params.commandActions;
        // Native Windows command display is shell-escaped; validate its parsed read action and exact file instead.
        safeRead = params.cwd && path.resolve(params.cwd) === cwd && Array.isArray(actions) && actions.length === 1 &&
          actions[0].type === 'read' && actions[0].command === 'Get-Content handoff.txt' &&
          path.resolve(actions[0].path) === path.join(cwd, 'handoff.txt');
        safeEdit = request.title === 'Codex · item/fileChange/requestApproval' && !params.grantRoot &&
          Array.isArray(params.changes) && params.changes.length === 1 &&
          path.resolve(params.changes[0].path) === path.join(cwd, 'handoff.txt') &&
          params.changes[0].kind.type === 'update' && !params.changes[0].kind.move_path;
      } catch { /* Other native requests are denied. */ }
      events.push({ profile: 'approval', kind: safeEdit ? 'allowed-fixture-edit' : safeRead ? 'allowed-fixture-read' : 'denied', text: request.detail });
      engine.answer(safeRead || safeEdit ? 'yes' : 'no', request.id);
    });
  };
  let engine: Engine | undefined;
  const abort = () => engine?.stop();
  context.signal.addEventListener('abort', abort, { once: true });
  console.log(`Live artifacts: ${root}`);
  try {
    engine = await manager.create({ title: 'OpenCode and Codex handoff', orchestrator: 'live-planner', workers: ['live-opencode', 'live-codex'] });
    attach(engine);
    await engine.submit('This is an authorized integration test in an isolated fixture project. Return exactly three dependent tasks: (1) live-opencode creates handoff.txt containing exactly OPENCODE_A followed by a newline; include the complete file contents in its report. (2) live-codex reads that file and appends CODEX_B followed by a newline, preserving OPENCODE_A; include the complete resulting contents in its report. (3) live-opencode reads the updated file and appends OPENCODE_C followed by a newline, preserving both earlier lines. All changes must stay in handoff.txt. Do not run builds/tests, create subagents, commit, publish, access external services or use integrations. Use native file editing tools; if needed, only a read-only Get-Content handoff.txt command is authorized. Return a three-task JSON plan with those exact worker IDs.');
    assert.equal(engine.state.error, undefined);
    assert.deepEqual(engine.state.session.tasks.map(task => task.profileId), ['live-opencode', 'live-codex', 'live-opencode']);
    assert.equal((await readFile(path.join(cwd, 'handoff.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'OPENCODE_A\nCODEX_B\nOPENCODE_C\n');
    assert(engine.state.session.tasks.every(task => task.status === 'completed'));
    assert(events.some(event => event.profile === 'live-codex' && /Codex skills loaded: handoff/.test(event.text)));
    const id = engine.state.session.id;
    const original = Object.fromEntries(engine.state.session.runs.map(run => [run.profileId, run.nativeSessionId]));
    assert.equal(engine.state.session.runs[1]!.nativeSessionId, engine.state.session.runs[3]!.nativeSessionId);
    engine = await manager.open(id); attach(engine);
    await engine.submit('Continue the authorized fixture integration test. Create exactly one task for live-codex: read handoff.txt and append CODEX_D followed by a newline, preserving all three existing lines. Change only handoff.txt. Do not run tests, builds, shell commands other than Get-Content handoff.txt, create subagents or access external services. Return a one-task JSON plan.');
    assert.equal(engine.state.error, undefined);
    assert.equal((await readFile(path.join(cwd, 'handoff.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'OPENCODE_A\nCODEX_B\nOPENCODE_C\nCODEX_D\n');
    for (const run of engine.state.session.runs) assert.equal(run.nativeSessionId, original[run.profileId]);
    assert(engine.state.session.tasks.every(task => task.changedFiles?.every(file => file === 'handoff.txt')));
    await writeFile(path.join(root, 'handoff-result.json'), JSON.stringify({ sessionId: id, nativeSessions: original, runs: engine.state.session.runs, events }, null, 2));
    engine = await manager.create({ title: 'Codex plans', orchestrator: 'live-codex', workers: ['live-opencode'] }); attach(engine);
    await engine.submit('This is ordinary conversation only, with no file work. Put exactly CODEX_PLANNER_OK in summary and return tasks: []. Do not call tools or create subagents.');
    assert.equal(engine.state.error, undefined);
    assert.equal(engine.state.session.summary, 'CODEX_PLANNER_OK');
    assert.equal(engine.state.session.tasks.length, 0);
    assert.equal(engine.state.session.runs[0]!.harness, 'codex');
    assert.equal(engine.state.session.runs[0]!.role, 'orchestrator');
    console.log(JSON.stringify({ passed: true, artifacts: root, handoffSessionId: id, codexPlannerSessionId: engine.state.session.id, resume: true }));
  } finally { context.signal.removeEventListener('abort', abort); await engine?.shutdown(); await writeFile(path.join(root, 'events.json'), JSON.stringify(events, null, 2)); }
});

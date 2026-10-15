import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { findCodex, runCodex } from '../src/codex.js';
import { loadProfile, builtinRoot } from '../src/profiles.js';
import type { RunInput } from '../src/adapters.js';

async function fixture(work: (input: RunInput) => Promise<void>) {
  const parent = path.resolve('.subharness/tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'codex-'));
  const previous = process.env.SUBHARNESS_CODEX_BIN;
  process.env.SUBHARNESS_CODEX_BIN = process.execPath;
  try { await work({ profile: await loadProfile(path.join(builtinRoot, 'codex')), cwd: root, stateRoot: path.join(root, 'state'), prompt: 'Fixture',
    signal: new AbortController().signal, ask: async () => 'no', onEvent: () => {} }); }
  finally { if (previous === undefined) delete process.env.SUBHARNESS_CODEX_BIN; else process.env.SUBHARNESS_CODEX_BIN = previous; await rm(root, { recursive: true, force: true }); }
}
function server(handle: (message: any, reply: (message: unknown) => void) => void) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  let buffer = '';
  const reply = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdin.setEncoding('utf8'); child.stdin.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) >= 0) { const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); queueMicrotask(() => handle(message, reply)); }
  });
  const launch = (() => child as unknown as ChildProcess) as typeof spawn;
  return { child, launch, reply };
}
function basic(message: any, reply: (message: unknown) => void, input: RunInput) {
  switch (message.method) {
    case 'initialize': reply({ id: message.id, result: {} }); return true;
    case 'skills/extraRoots/set': reply({ id: message.id, result: {} }); return true;
    case 'skills/list': reply({ id: message.id, result: { data: [{ skills: [{ name: 'handoff', enabled: true, path: path.join(input.stateRoot, 'staged', input.profile.checksum, 'skills/handoff/SKILL.md') }] }] } }); return true;
    case 'thread/start': case 'thread/resume': reply({ id: message.id, result: { thread: { id: 'native-thread' } } }); return true;
    case 'initialized': return true;
  }
  return false;
}
function complete(reply: (message: unknown) => void, text = 'DELIVERED', status = 'completed') {
  reply({ method: 'item/agentMessage/delta', params: { threadId: 'native-thread', delta: text } });
  reply({ method: 'item/completed', params: { threadId: 'native-thread', item: { id: 'answer', type: 'agentMessage', text, phase: 'final_answer' } } });
  reply({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn', status, error: status === 'failed' ? { message: 'Provider offline' } : null } } });
}

test('Codex resumes native threads, injects loaded skills, streams text and forwards one-time approval', () => fixture(async input => {
  const requests: any[] = [], events: any[] = [];
  const mock = server((message, reply) => {
    requests.push(message);
    if (basic(message, reply, input)) return;
    if (message.method === 'turn/start') {
      reply({ id: message.id, result: { turn: { id: 'turn' } } });
      reply({ method: 'item/commandExecution/requestApproval', id: 'approve', params: { threadId: 'native-thread', turnId: 'turn', command: 'Read fixture' } });
    } else if (message.id === 'approve') { assert.equal(message.result.decision, 'accept'); complete(reply); }
  });
  const result = await runCodex({ ...input, sessionId: 'native-thread', onEvent: e => events.push(e), ask: async (kind, _title, detail) => { assert.equal(kind, 'permission'); assert.match(detail, /Read fixture/); return 'yes'; } }, 'fixture-model', mock.launch);
  assert.equal(result.text, 'DELIVERED'); assert.equal(result.sessionId, 'native-thread');
  const resume = requests.find(r => r.method === 'thread/resume');
  assert.equal(resume.params.approvalPolicy, 'untrusted'); assert.equal(resume.params.sandbox, 'workspace-write');
  assert.equal(resume.params.model, 'fixture-model'); assert.equal(resume.params.excludeTurns, true);
  assert(!requests.some(r => r.method === 'thread/start'));
  assert(requests.find(r => r.method === 'turn/start').params.input.some((item: any) => item.type === 'skill' && item.name === 'handoff'));
  assert(events.some(e => e.kind === 'text' && e.text === 'DELIVERED'));
}));

test('Codex planning uses read-only mode, output schema and declines escalation', () => fixture(async input => {
  const schema = { type: 'object', properties: { summary: { type: 'string' } } };
  const mock = server((message, reply) => {
    if (message.method === 'thread/start') { assert.equal(message.params.sandbox, 'read-only'); }
    if (basic(message, reply, input)) return;
    if (message.method === 'turn/start') {
      assert.deepEqual(message.params.outputSchema, schema); reply({ id: message.id, result: { turn: { id: 'turn' } } });
      reply({ id: 50, method: 'item/permissions/requestApproval', params: { threadId: 'native-thread', permissions: { network: { enabled: true } } } });
    } else if (message.id === 50) { assert.deepEqual(message.result, { permissions: {}, scope: 'turn' }); complete(reply, '{"summary":"Plan"}'); }
  });
  const result = await runCodex({ ...input, role: 'orchestrator', schema, ask: async () => assert.fail('Planner must not escalate') }, undefined, mock.launch);
  assert.deepEqual(JSON.parse(result.text), { summary: 'Plan' });
}));

test('Codex rejects missing skills, bundled plugins, malformed output and failed native turns', () => fixture(async input => {
  await assert.rejects(runCodex({ ...input, profile: { ...input.profile, manifest: { ...input.profile.manifest, plugins: ['plugins/native'] } } }), /Packaged Codex plugins/);
  const missing = server((message, reply) => {
    if (message.method === 'skills/list') reply({ id: message.id, result: { data: [{ skills: [] }] } });
    else basic(message, reply, input);
  });
  await assert.rejects(runCodex(input, undefined, missing.launch), /skill failed to load/);
  const malformed = server((_message, _reply) => { malformed.child.stdout.write('invalid json\n'); });
  await assert.rejects(runCodex(input, undefined, malformed.launch), /JSON|Unexpected/);
  const failed = server((message, reply) => { if (basic(message, reply, input)) return; if (message.method === 'turn/start') { reply({ id: message.id, result: { turn: { id: 'turn' } } }); complete(reply, '', 'failed'); } });
  await assert.rejects(runCodex(input, undefined, failed.launch), /Provider offline/);
}));

test('Codex stop interrupts a pending native turn and handles process failure', () => fixture(async input => {
  const controller = new AbortController(); let interrupted = false;
  const mock = server((message, reply) => {
    if (basic(message, reply, input)) return;
    if (message.method === 'turn/start') { reply({ id: message.id, result: { turn: { id: 'turn' } } }); setTimeout(() => controller.abort(), 5); }
    if (message.method === 'turn/interrupt') { interrupted = true; reply({ id: message.id, result: {} }); }
  });
  await assert.rejects(runCodex({ ...input, signal: controller.signal }, undefined, mock.launch), /Stopped/);
  assert(interrupted);
  const crashed = server(() => crashed.child.emit('exit', 2));
  await assert.rejects(runCodex(input, undefined, crashed.launch), /Codex exited \(2\)/);
}));

test('Codex native executable discovery rejects shell shims', async () => {
  const previous = process.env.SUBHARNESS_CODEX_BIN;
  try { process.env.SUBHARNESS_CODEX_BIN = 'unsafe.cmd'; await assert.rejects(findCodex(), /native executable/); }
  finally { if (previous === undefined) delete process.env.SUBHARNESS_CODEX_BIN; else process.env.SUBHARNESS_CODEX_BIN = previous; }
});

test('Codex file approval presents the native proposed paths and diffs', () => fixture(async input => {
  const changes = [{ path: path.join(input.cwd, 'result.txt'), kind: { type: 'update', move_path: null }, diff: '+DELIVERED' }];
  let approved = false;
  const mock = server((message, reply) => {
    if (basic(message, reply, input)) return;
    if (message.method === 'turn/start') {
      reply({ id: message.id, result: { turn: { id: 'turn' } } });
      reply({ method: 'item/started', params: { threadId: 'native-thread', item: { id: 'edit', type: 'fileChange', changes } } });
      reply({ method: 'item/fileChange/requestApproval', id: 'edit-approval', params: { threadId: 'native-thread', turnId: 'turn', itemId: 'edit' } });
    } else if (message.id === 'edit-approval') { assert.equal(message.result.decision, 'accept'); complete(reply); }
  });
  await runCodex({ ...input, ask: async (_kind, _title, detail) => { assert.deepEqual(JSON.parse(detail).changes, changes); approved = true; return 'yes'; } }, undefined, mock.launch);
  assert(approved);
  const blind = server((message, reply) => {
    if (basic(message, reply, input)) return;
    if (message.method === 'turn/start') {
      reply({ id: message.id, result: { turn: { id: 'turn' } } });
      reply({ method: 'item/fileChange/requestApproval', id: 'blind', params: { threadId: 'native-thread', itemId: 'unknown' } });
    }
  });
  await assert.rejects(runCodex({ ...input, ask: async () => assert.fail('Do not ask for blind approval') }, undefined, blind.launch), /did not provide a file diff/);
}));

test('Codex forwards native questions and cancels a prompt resolved by the server', () => fixture(async input => {
  let cancelled = false, questions = 0;
  const mock = server((message, reply) => {
    if (basic(message, reply, input)) return;
    if (message.method === 'turn/start') {
      reply({ id: message.id, result: { turn: { id: 'turn' } } });
      reply({ method: 'item/tool/requestUserInput', id: 'question', params: { threadId: 'native-thread', questions: [{ id: 'choice', question: 'Choose', options: [] }] } });
    } else if (message.id === 'question') {
      assert.deepEqual(message.result.answers, { choice: { answers: ['Option A'] } });
      reply({ method: 'item/commandExecution/requestApproval', id: 'stale', params: { threadId: 'native-thread', command: 'Pending action' } });
      setTimeout(() => { reply({ method: 'serverRequest/resolved', params: { threadId: 'native-thread', requestId: 'stale' } }); complete(reply); }, 5);
    } else if (message.id === 'stale') assert.fail('Resolved requests must not be answered again');
  });
  const result = await runCodex({ ...input, ask: async (kind, _title, _detail, signal) => {
    if (kind === 'question') { questions++; return 'Option A'; }
    return await new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new Error('Resolved')); }, { once: true }));
  } }, undefined, mock.launch);
  assert.equal(result.text, 'DELIVERED'); assert.equal(questions, 1); assert(cancelled);
}));

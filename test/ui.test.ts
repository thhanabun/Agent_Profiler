import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { render, renderToString } from 'ink';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { Engine, redact } from '../src/engine.js';
import { loadProfiles } from '../src/profiles.js';
import { App } from '../src/ui.js';
import { readMemory } from '../src/memory.js';
import { exitWithRestoreRetry } from '../src/terminal.js';
import { WorkspaceApp } from '../src/workspace-ui.js';
import { SessionManager } from '../src/application.js';

test('terminal renders three panes at wide widths and a usable compact layout', async () => {
  const engine = new Engine({ cwd: process.cwd(), stateRoot: '.workerdeck/ui-fixture', profiles: await loadProfiles(), demo: true });
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  try {
    Object.defineProperty(process.stdout, 'columns', { value: 140, configurable: true });
    const wide = redact(renderToString(React.createElement(App, { engine }), { columns: 140 }));
    assert.match(wide, /FLOW/);
    assert.match(wide, /CONVERSATION/);
    assert.match(wide, /INSPECT/);
    assert.match(wide, /SIMULATION/);
    Object.defineProperty(process.stdout, 'columns', { value: 70, configurable: true });
    const narrow = redact(renderToString(React.createElement(App, { engine }), { columns: 70 }));
    assert.match(narrow, /CONVERSATION/);
    assert.match(narrow, /Tell the orchestrator/);
  } finally {
    if (original) Object.defineProperty(process.stdout, 'columns', original);
    else Reflect.deleteProperty(process.stdout, 'columns');
  }
});

test('Windows terminal cleanup retries only a transient raw-mode restore failure', () => {
  const failure = Object.assign(new Error('setRawMode EPERM'), { code: 'EPERM', syscall: 'setRawMode' });
  let calls = 0;
  exitWithRestoreRetry(() => { if (++calls === 1) throw failure; }, 'win32');
  assert.equal(calls, 2);
  calls = 0;
  assert.throws(() => exitWithRestoreRetry(() => { calls++; throw failure; }, 'win32'), /setRawMode/);
  assert.equal(calls, 2);
  assert.throws(() => exitWithRestoreRetry(() => { throw failure; }, 'linux'), /setRawMode/);
  const unrelated = Object.assign(new Error('file permission denied'), { code: 'EPERM', syscall: 'open' });
  assert.throws(() => exitWithRestoreRetry(() => { throw unrelated; }, 'win32'), /file permission/);
});

test('terminal keyboard edits at the cursor, accepts Thai memory commands and forwards approvals', async () => {
  const parent = path.join(process.cwd(), '.workerdeck', 'tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'terminal-'));
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 130, rows: 34 });
  stdout.resume();
  const engine = new Engine({ cwd: root, stateRoot: root, profiles: await loadProfiles(), demo: true,
    runner: async () => ({ text: '', structured: { summary: 'Chat reply', tasks: [] }, sessionId: 'p' }) });
  const app = render(React.createElement(App, { engine }), { stdin, stdout, stderr: stdout, patchConsole: false, exitOnCtrlC: false, interactive: true });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100; i++) { if (check()) return; await delay(20); }
    assert.fail('Terminal action did not finish.');
  };
  const key = async (value: string) => { stdin.write(value); await delay(40); };
  try {
    await delay(80);
    await key('abc');
    await key('\x1b[D');
    await key('\x1b[3~');
    await key('\x7f');
    await key('\r');
    await until(() => engine.state.session.messages.some(message => message.role === 'user'));
    assert.equal(engine.state.session.messages.find(message => message.role === 'user')!.text, 'a');
    await until(() => !engine.state.busy);
    await key('/remember ชอบภาษาไทย');
    await key('\r');
    await until(() => engine.state.session.messages.some(message => message.text.startsWith('Remembered')));
    assert.equal((await readMemory(root))[0]!.text, 'ชอบภาษาไทย');
    const answer = engine.ask('permission', 'Fixture permission', 'No operation is executed.', new AbortController().signal);
    await until(() => Boolean(engine.state.request));
    await key('yes'); await key('\r');
    assert.equal(await answer, 'yes');
  } finally {
    app.unmount(); await engine.shutdown();
    stdin.destroy(); stdout.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace team picker creates chats, restores saved sessions and refuses navigation during work', async () => {
  const parent = path.resolve('.workerdeck/tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'workspace-ui-'));
  const manager = new SessionManager({ cwd: root, stateRoot: path.join(root, 'state'), store: path.join(root, 'images'), extraRoot: path.join(root, 'profiles'), demo: true,
    runner: async input => {
      if (input.prompt.includes('hold-fixture')) return await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('Stopped fixture')), { once: true }));
      return { text: '', structured: { summary: 'Saved chat reply', tasks: [] }, sessionId: 'native-fixture' };
    } });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 140, rows: 36 });
  let output = ''; stdout.on('data', chunk => { output = (output + redact(chunk.toString())).slice(-180000); });
  const app = render(React.createElement(WorkspaceApp, { manager, initialTitle: 'แชตแรก' }), { stdin, stdout, stderr: stdout, patchConsole: false, exitOnCtrlC: false, interactive: true });
  const until = async (check: () => boolean) => { for (let n = 0; n < 200; n++) { if (check()) return; await delay(20); } assert.fail('Workspace action timed out.'); };
  const key = async (value: string) => { stdin.write(value); await delay(80); };
  const command = async (value: string) => { await key(value); await key('\r'); };
  try {
    await until(() => output.includes('@orchestrator') && output.includes('@codex'));
    assert.equal((await manager.list()).length, 0); // Opening the startup picker creates no empty session.
    await key('\x1b[A'); await key('\x1b[A'); // Choose Codex as planner rather than its worker hint.
    await key('\r');
    await until(() => output.includes('2/2'));
    await key(' '); await key(' '); // Toggle the selected implement worker off/on.
    await key('\x1b[B'); await key('\x1b[B'); await key(' '); // Add review.
    await key('\r');
    await until(() => Boolean(manager.active));
    const first = manager.active!;
    await until(() => first.listenerCount('change') > 0);
    assert.equal(first.orchestratorProfileId, 'codex');
    assert.deepEqual(first.workerProfileIds.sort(), ['implement', 'review']);
    assert.equal(first.state.session.title, 'แชตแรก');
    await command('Hello'); await until(() => !first.state.busy && first.state.session.messages.some(message => message.text === 'Saved chat reply'));
    await command('/new Second session'); await delay(120); await key('\r'); await key('\r');
    await until(() => manager.active !== first);
    const second = manager.active!;
    await until(() => second.listenerCount('change') > 0);
    assert.equal(second.state.session.title, 'Second session');
    assert.equal(first.listenerCount('change'), 0);
    await command('/sessions'); await delay(120); await key('\x1b[B'); await key('\r');
    await until(() => manager.active?.state.session.id === first.state.session.id);
    await until(() => manager.active!.listenerCount('change') > 0);
    assert(manager.active!.state.session.messages.some(message => message.text === 'Saved chat reply'));
    assert.equal(manager.active!.state.session.runs.length, 1); // Opening does not execute pending work.
    await command('/team'); await delay(120); await key('\x1b');
    assert.equal((await manager.list()).length, 2);
    await command('hold-fixture'); await until(() => manager.active!.state.busy);
    await command('/sessions'); await until(() => output.includes('Use /stop'));
    assert.equal(manager.active!.state.session.id, first.state.session.id);
    await command('/stop'); await until(() => !manager.active!.state.busy);
    await command('/sessions'); await delay(120); await key('\x1b');
    assert.equal(manager.active!.state.session.id, first.state.session.id);
  } finally { app.unmount(); await manager.shutdown(); stdin.destroy(); stdout.destroy(); await rm(root, { recursive: true, force: true }); }
});

test('workspace session picker filters live history out of simulation mode', async () => {
  const parent = path.resolve('.workerdeck/tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'workspace-mode-'));
  const options = { cwd: root, stateRoot: path.join(root, 'state'), store: path.join(root, 'images'), extraRoot: path.join(root, 'profiles') };
  const live = new SessionManager(options); await live.create({ direct: 'codex', title: 'HIDDEN_LIVE_SESSION' }); await live.shutdown();
  const manager = new SessionManager({ ...options, demo: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 70, rows: 28 });
  let output = ''; stdout.on('data', chunk => { output += redact(chunk.toString()); });
  const app = render(React.createElement(WorkspaceApp, { manager }), { stdin, stdout, stderr: stdout, patchConsole: false, exitOnCtrlC: false, interactive: true });
  try {
    for (let n = 0; n < 100 && !output.includes('@orchestrator'); n++) await delay(20);
    stdin.write('s');
    for (let n = 0; n < 100 && !output.includes('No saved sessions in this mode.'); n++) await delay(20);
    assert(output.includes('No saved sessions in this mode.'));
    assert(!output.includes('HIDDEN_LIVE_SESSION'));
    assert.equal(manager.active, undefined);
  } finally { app.unmount(); await manager.shutdown(); stdin.destroy(); stdout.destroy(); await rm(root, { recursive: true, force: true }); }
});

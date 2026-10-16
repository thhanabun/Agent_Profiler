import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

async function project(work: (root: string) => Promise<void>) {
  const parent = path.resolve('.workerdeck/tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'host project with spaces-'));
  try { await work(root); }
  finally {
    assert(root.startsWith(parent + path.sep));
    await rm(root, { recursive: true, force: true });
  }
}

function launch(args: string[]) {
  const host = spawn(process.execPath, [
    '--import', 'tsx', fileURLToPath(new URL('../server/index.ts', import.meta.url)), ...args,
  ], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  let stderr = '';
  host.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const output = createInterface({ input: host.stdout });
  const messages = output[Symbol.asyncIterator]();
  const ready = async () => {
    const line = await messages.next();
    assert(!line.done, 'Host closed before announcing readiness.');
    const value = JSON.parse(line.value);
    assert.equal(value.event, 'host.ready');
    assert(typeof value.token === 'string' && value.token.length >= 32);
    return value as { url: string; token: string; cwd: string; stateDir: string; demo: boolean };
  };
  return { host, closed: once(host, 'close'), stderr: () => stderr, ready, output };
}

async function list(ready: { url: string; token: string }) {
  const response = await fetch(new URL('/api/session.list', ready.url), {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${ready.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, id: 'sessions', method: 'session.list', params: {} }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { version: 1, id: 'sessions', ok: true, result: [] });
}

test('HTTP CLI fixes the project with spaces and releases its child lock on stdin EOF', { timeout: 30000 }, () => project(async root => {
  const { host, closed, stderr, ready, output } = launch(['--cwd', root, '--port', '0', '--demo']);
  try {
    const started = await ready();
    assert.equal(started.cwd, await realpath(root));
    assert.equal(started.stateDir, path.join(started.cwd, '.workerdeck'));
    assert.equal(started.demo, true);
    assert.equal(new URL(started.url).hostname, '127.0.0.1');
    const lock = JSON.parse(await readFile(path.join(root, '.workerdeck/runner.lock'), 'utf8'));
    assert(Number.isSafeInteger(lock.pid));
    assert.notEqual(lock.pid, host.pid);
    await list(started);
    host.stdin.end();
    assert.equal((await closed)[0], 0, stderr());
    await assert.rejects(readFile(path.join(root, '.workerdeck/runner.lock')), { code: 'ENOENT' });
  } finally {
    host.stdin.end();
    await closed;
    output.close();
  }
}));

test('local host reports a locked project without removing another owner lock', { timeout: 30000 }, () => project(async root => {
  const stateRoot = path.join(root, '.workerdeck');
  await mkdir(stateRoot);
  const lock = JSON.stringify({ pid: process.pid });
  await writeFile(path.join(stateRoot, 'runner.lock'), lock);
  const { host, closed, stderr, output } = launch(['--cwd', root, '--port', '0', '--demo']);
  try {
    host.stdin.end();
    assert.equal((await closed)[0], 1);
    assert.match(stderr(), /Another WorkerDeck process/);
    assert.equal(await readFile(path.join(stateRoot, 'runner.lock'), 'utf8'), lock);
  } finally { host.stdin.end(); await closed; output.close(); }
}));

test('local host requires an explicit project directory', { timeout: 30000 }, async () => {
  const { host, closed, stderr, output } = launch(['--port', '0', '--demo']);
  try {
    host.stdin.end();
    assert.equal((await closed)[0], 1);
    assert.match(stderr(), /--cwd <project>/);
  } finally { host.stdin.end(); await closed; output.close(); }
});

test('occupied HTTP port releases the new project lock and leaves the first host running', { timeout: 30000 }, () => project(root => project(async other => {
  const first = launch(['--cwd', root, '--port', '0', '--demo']);
  let second: ReturnType<typeof launch> | undefined;
  try {
    const started = await first.ready();
    second = launch(['--cwd', other, '--port', new URL(started.url).port, '--demo']);
    assert.equal((await second.closed)[0], 1);
    assert.match(second.stderr(), /EADDRINUSE|address already in use/i);
    await assert.rejects(readFile(path.join(other, '.workerdeck/runner.lock')), { code: 'ENOENT' });
    await list(started);
    assert.equal(first.host.exitCode, null);
  } finally {
    if (second) { second.host.stdin.end(); await second.closed; second.output.close(); }
    first.host.stdin.end(); await first.closed; first.output.close();
  }
})));

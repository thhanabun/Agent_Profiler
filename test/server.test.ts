import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

async function project(work: (root: string) => Promise<void>) {
  const parent = path.resolve('.subharness/tests');
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
  return { host, closed: once(host, 'close'), stderr: () => stderr };
}

test('local host forwards JSONL for a fixed project with spaces and releases its lock on EOF', { timeout: 30000 }, () => project(async root => {
  const { host, closed, stderr } = launch(['--cwd', root]);
  const output = createInterface({ input: host.stdout });
  const messages = output[Symbol.asyncIterator]();
  const next = async () => {
    const line = await messages.next();
    assert(!line.done, stderr());
    return JSON.parse(line.value);
  };
  try {
    const ready = await next();
    assert.equal(ready.version, 1);
    assert.equal(ready.event, 'ready');
    assert(ready.methods.includes('session.list'));
    const lock = JSON.parse(await readFile(path.join(root, '.subharness/runner.lock'), 'utf8'));
    assert(Number.isSafeInteger(lock.pid));
    assert.notEqual(lock.pid, host.pid);
    host.stdin.write(JSON.stringify({ version: 1, id: 'sessions', method: 'session.list', params: {} }) + '\n');
    assert.deepEqual(await next(), { version: 1, id: 'sessions', ok: true, result: [] });
    host.stdin.end();
    assert.equal((await closed)[0], 0, stderr());
    await assert.rejects(readFile(path.join(root, '.subharness/runner.lock')), { code: 'ENOENT' });
  } finally {
    host.stdin.end();
    await closed;
    output.close();
  }
}));

test('local host reports a locked project without removing another owner lock', { timeout: 30000 }, () => project(async root => {
  const stateRoot = path.join(root, '.subharness');
  await mkdir(stateRoot);
  const lock = JSON.stringify({ pid: process.pid });
  await writeFile(path.join(stateRoot, 'runner.lock'), lock);
  const { host, closed, stderr } = launch(['--cwd', root]);
  host.stdout.resume();
  host.stdin.end();
  assert.equal((await closed)[0], 1);
  assert.match(stderr(), /Another Subharness process/);
  assert.equal(await readFile(path.join(stateRoot, 'runner.lock'), 'utf8'), lock);
}));

test('local host requires an explicit project directory', { timeout: 30000 }, async () => {
  const { host, closed, stderr } = launch([]);
  host.stdout.resume();
  host.stdin.end();
  assert.equal((await closed)[0], 1);
  assert.match(stderr(), /--cwd <project>/);
});

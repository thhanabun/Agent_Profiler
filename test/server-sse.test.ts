import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

async function within<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

test('pipelined SSE reserves capacity, releases socket slots and lets the CLI exit', { timeout: 45000 }, async () => {
  const parent = path.resolve('.subharness/tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'pipelined SSE host with spaces-'));
  // Queued SSE responses cannot reach the wire behind the first endless response.
  const observer = `
    import { ServerResponse } from 'node:http';
    const writeHead = ServerResponse.prototype.writeHead;
    let watchedSocket;
    ServerResponse.prototype.writeHead = function(status, ...args) {
      if (this.req.url === '/api/events' && this.req.headers.host === '127.0.0.1:' + this.req.socket.localPort) {
        process.stdout.write(JSON.stringify({ event: 'test.sse.status', status }) + '\\n');
        if (!watchedSocket) {
          watchedSocket = this.req.socket;
          watchedSocket.once('close', () => process.stdout.write(JSON.stringify({ event: 'test.sse.socket.closed' }) + '\\n'));
        }
      }
      return writeHead.call(this, status, ...args);
    };
  `;
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--import', `data:text/javascript;base64,${Buffer.from(observer).toString('base64')}`,
    fileURLToPath(new URL('../server/index.ts', import.meta.url)), '--cwd', root, '--port', '0', '--demo',
  ], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
    env: { ...process.env, SUBHARNESS_IMAGE_STORE: path.join(root, 'images') },
  });
  const closed = once(child, 'close');
  void closed.catch(() => {});
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const output = createInterface({ input: child.stdout });
  const messages = output[Symbol.asyncIterator]();
  const next = async () => {
    const line = await within(messages.next(), 15000, 'CLI did not produce the expected SSE probe message.');
    assert(!line.done, `CLI exited unexpectedly: ${stderr}`);
    return JSON.parse(line.value);
  };
  const controller = new AbortController();
  let socket: ReturnType<typeof connect> | undefined;
  let runtimePid: number | undefined;
  try {
    const ready = await next();
    assert.equal(ready.event, 'host.ready');
    runtimePid = JSON.parse(await readFile(path.join(root, '.subharness/runner.lock'), 'utf8')).pid;
    const origin = new URL(ready.url);
    socket = connect(Number(origin.port), origin.hostname);
    socket.on('error', () => {});
    await within(once(socket, 'connect'), 5000, 'Raw SSE socket did not connect.');
    const request = `GET /api/events HTTP/1.1\r\nHost: ${origin.host}\r\nAuthorization: Bearer ${ready.token}\r\nConnection: keep-alive\r\n\r\n`;
    socket.write(request.repeat(17));
    const statuses: number[] = [];
    for (let count = 0; count < 17; count++) {
      const message = await next();
      assert.equal(message.event, 'test.sse.status'); statuses.push(message.status);
    }
    assert.equal(statuses.filter(status => status === 200).length, 16);
    assert.equal(statuses.filter(status => status === 429).length, 1);
    socket.destroy();
    assert.equal((await next()).event, 'test.sse.socket.closed');

    const streams: Response[] = [];
    for (let count = 0; count < 16; count++) {
      const response = await fetch(new URL('/api/events', ready.url), {
        headers: { authorization: `Bearer ${ready.token}` },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      });
      assert.equal(response.status, 200, 'Disconnected pipeline must release every SSE slot.');
      streams.push(response);
    }
    const full = await fetch(new URL('/api/events', ready.url), {
      headers: { authorization: `Bearer ${ready.token}` }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(full.status, 429); await full.arrayBuffer();
    const drained = Promise.all(streams.map(stream => stream.arrayBuffer()));
    void drained.catch(() => {});
    child.stdin.end();
    assert.equal((await within(closed, 10000, 'SSE heartbeats kept the CLI alive after shutdown.'))[0], 0, stderr);
    await within(drained, 1000, 'SSE streams did not end during CLI shutdown.');
    await assert.rejects(readFile(path.join(root, '.subharness/runner.lock')), { code: 'ENOENT' });
  } finally {
    socket?.destroy(); controller.abort(); child.stdin.end();
    if (child.exitCode === null && child.signalCode === null
      && !await Promise.race([closed.then(() => true), delay(1000, false)])) {
      child.kill('SIGKILL'); await closed;
      const lock = JSON.parse(await readFile(path.join(root, '.subharness/runner.lock'), 'utf8').catch(() => 'null'));
      if (runtimePid && lock?.pid === runtimePid) {
        try { process.kill(runtimePid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    output.close();
    assert(root.startsWith(parent + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});

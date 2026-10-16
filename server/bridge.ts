import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { ProtocolEvent as ContractProtocolEvent, ProtocolRequest, ProtocolResponse } from '../src/contracts.js';
import { stopProcess } from '../src/process.js';

export type Request = ProtocolRequest;
export type Reply = ProtocolResponse;
export type ProtocolEvent = ContractProtocolEvent;

export class Bridge extends EventEmitter {
  readonly child;
  readonly ready: Promise<Extract<ProtocolEvent, { event: 'ready' }>>;
  readonly closed: Promise<void>;
  latest?: Extract<ProtocolEvent, { event: 'session.state' }>;
  failure?: Error;
  private stopping = false;
  private closing?: Promise<void>;
  private failShutdown?: (error: Error) => void;
  private readonly pending = new Map<string, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();

  constructor(cwd: string, stateDir: string, demo: boolean) {
    super();
    this.child = spawn(process.execPath, [
      fileURLToPath(new URL('../bin/workerdeck.mjs', import.meta.url)),
      'serve', '--stdio', '--cwd', cwd, '--state-dir', stateDir, ...(demo ? ['--demo'] : []),
    ], { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32' });
    let ready = false;
    let acceptReady!: (event: Extract<ProtocolEvent, { event: 'ready' }>) => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { acceptReady = resolve; rejectReady = reject; });
    const timer = setTimeout(() => fail(new Error('CLI did not become ready within 30 seconds.')), 30000);
    const fail = (error: Error) => {
      if (this.failure) return;
      this.failure = error;
      clearTimeout(timer);
      rejectReady(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.emit('failure', error);
      this.child.stdin.end();
    };
    this.failShutdown = fail;
    this.child.stderr.pipe(process.stderr, { end: false });
    this.child.stdin.on('error', fail);
    this.child.once('error', fail);
    const line = (text: string) => {
      try {
        const message = JSON.parse(text);
        if (message?.version !== 1) throw new Error('Invalid CLI protocol version.');
        if (typeof message.event === 'string') {
          if (message.event === 'ready') {
            if (ready || !Array.isArray(message.methods)) throw new Error('Invalid CLI ready event.');
            ready = true; clearTimeout(timer); acceptReady(message as Extract<ProtocolEvent, { event: 'ready' }>);
          } else if (message.event === 'session.state') this.latest = message as Extract<ProtocolEvent, { event: 'session.state' }>;
          else if (message.event !== 'operation.error') throw new Error('Unknown CLI event.');
          this.emit('event', message);
        } else if (typeof message.id === 'string' && typeof message.ok === 'boolean') {
          this.pending.get(message.id)?.resolve(message);
        } else throw new Error('Invalid CLI reply.');
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    };
    let buffer = '';
    const maximum = 16 * 1024 * 1024;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      if (this.failure) return;
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(message) > maximum) { buffer = ''; fail(new Error('CLI protocol message exceeds 16 MiB.')); return; }
        if (message.trim()) line(message);
        if (this.failure) { buffer = ''; return; }
      }
      if (Buffer.byteLength(buffer) > maximum) { buffer = ''; fail(new Error('CLI protocol message exceeds 16 MiB.')); }
    });
    this.child.stdout.on('error', fail);
    this.child.stdout.once('end', () => {
      if (!this.failure && buffer.trim()) line(buffer);
      buffer = '';
      if (!this.stopping) fail(new Error('CLI stdout closed unexpectedly.'));
    });
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (!ready || !this.stopping || code !== 0) fail(new Error(`CLI closed (code ${code}, signal ${signal ?? 'none'}).`));
      else {
        for (const pending of this.pending.values()) pending.reject(new Error('CLI closed.'));
        this.pending.clear();
      }
      this.emit('closed'); resolve();
    }));
  }

  request<R extends ProtocolRequest>(request: R, signal?: AbortSignal): Promise<ProtocolResponse<R['method']>> {
    if (this.failure || this.stopping) return Promise.reject(this.failure ?? new Error('CLI is stopping.'));
    if (this.pending.size >= 64) return Promise.reject(new Error('Too many pending CLI requests.'));
    const id = randomUUID();
    const line = JSON.stringify({ ...request, id }) + '\n';
    if (Buffer.byteLength(line) > 65536) return Promise.reject(new Error('Request exceeds the 64 KiB JSONL limit.'));
    return new Promise<ProtocolResponse<R['method']>>((resolve, reject) => {
      const finish = (error?: Error, reply?: Reply) => {
        clearTimeout(timer); signal?.removeEventListener('abort', aborted); this.pending.delete(id);
        if (error) reject(error); else resolve({ ...reply!, id: request.id } as ProtocolResponse<R['method']>);
      };
      const aborted = () => finish(new Error('HTTP client disconnected.'));
      const timer = setTimeout(() => finish(new Error('CLI request timed out after 30 seconds.')), 30000);
      this.pending.set(id, { resolve: reply => finish(undefined, reply), reject: error => finish(error) });
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      this.child.stdin.write(line, error => { if (error) finish(error); });
    });
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.stopping = true;
      this.child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const graceful = await Promise.race([this.closed.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 10_000); })]);
      clearTimeout(timer);
      if (!graceful) {
        this.failShutdown?.(new Error('CLI did not stop after EOF within 10 seconds; terminating its process tree.'));
        await stopProcess(this.child);
      }
    })();
  }
}

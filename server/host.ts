import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestSchema } from '../src/protocol.js';
import { Bridge, type ProtocolEvent, type Request } from './bridge.js';
import { serveStatic } from './static.js';

const webRoot = fileURLToPath(new URL('../web/dist/', import.meta.url));

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function startHost(options: { cwd: string; port?: number; stateDir?: string; demo?: boolean }, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const cwd = await realpath(options.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error('--cwd must be an existing directory.');
  const stateDir = path.resolve(options.stateDir ?? path.join(cwd, '.subharness'));
  const port = options.port ?? 5174;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535.');
  const demo = options.demo ?? false;
  const token = randomBytes(32).toString('base64url');
  const authorization = Buffer.from(`Bearer ${token}`);
  const bridge = new Bridge(cwd, stateDir, demo);
  const streams = new Set<ServerResponse>();
  let origin = '';
  let stopping = false;
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;
  const json = (response: ServerResponse, status: number, value: unknown) => {
    if (!response.destroyed && !response.writableEnded) {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify(value));
    }
  };
  const sendEvent = (response: ServerResponse, event: ProtocolEvent) => {
    if (response.destroyed || response.writableEnded) return;
    if (response.writableNeedDrain) { response.destroy(); return; }
    response.write(`event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  bridge.on('event', event => { for (const response of streams) sendEvent(response, event); });
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.headers.host !== origin.slice(7) || (request.headers.origin !== undefined && request.headers.origin !== origin)
        || (request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))))
        throw new HttpError(403, 'Unexpected Host or Origin.');
      if (stopping || bridge.failure) throw new HttpError(503, 'Host is stopping.');
      const url = new URL(request.url ?? '/', origin);
      if (url.origin !== origin) throw new HttpError(400, 'Unexpected URL origin.');
      if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
        await serveStatic(request, response, webRoot); return;
      }
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) throw new HttpError(401, 'Bearer token required.');
      if (url.search) throw new HttpError(400, 'Unexpected query parameters.');
      if (request.method === 'GET' && url.pathname === '/api/host') {
        json(response, 200, { cwd, stateDir, demo, methods: (await bridge.ready).methods }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        if (streams.size >= 16) throw new HttpError(429, 'Too many event streams.');
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'close', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
        sendEvent(response, await bridge.ready);
        if (bridge.latest) sendEvent(response, bridge.latest);
        streams.add(response);
        const heartbeat = setInterval(() => {
          if (response.writableNeedDrain) response.destroy(); else response.write(': keepalive\n\n');
        }, 15000);
        response.once('close', () => { clearInterval(heartbeat); streams.delete(response); });
        return;
      }
      const method = url.pathname.startsWith('/api/') ? url.pathname.slice(5) : '';
      if (request.method !== 'POST' || !requestSchema.shape.method.safeParse(method).success) throw new HttpError(404, 'Route not found.');
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json.');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 65535) {
          request.resume(); response.setHeader('Connection', 'close');
          throw new HttpError(413, 'Request exceeds the 64 KiB JSONL limit.');
        }
        chunks.push(chunk);
      }
      let parsed: Request;
      try { parsed = requestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { throw new HttpError(400, 'Invalid version 1 JSONL request.'); }
      if (parsed.method !== method) throw new HttpError(400, 'Route and JSONL method must match.');
      if (Buffer.byteLength(JSON.stringify({ ...parsed, id: '0'.repeat(36) })) + 1 > 65536) throw new HttpError(413, 'Request exceeds the 64 KiB JSONL limit.');
      if (response.destroyed) return;
      const controller = new AbortController();
      const disconnected = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', disconnected);
      try {
        if (parsed.method === 'session.create') {
          const params = parsed.params ?? {};
          if (!params || typeof params !== 'object' || Array.isArray(params)) throw new HttpError(400, 'Session parameters must be an object.');
          const fields = params as Record<string, unknown>;
          const choices = await bridge.request({ version: 1, id: 'host-choices', method: 'profiles.choices', params: {} }, controller.signal);
          if (!choices.ok || !Array.isArray(choices.result)) throw new HttpError(502, 'Could not load profile choices.');
          const allowed = new Set(choices.result.map(choice => choice.reference));
          const references = [fields.direct, fields.orchestrator, ...(Array.isArray(fields.workers) ? fields.workers : [])].filter(ref => ref !== undefined);
          if (references.some(ref => typeof ref !== 'string' || !allowed.has(ref))) throw new HttpError(403, 'Choose a profile reference returned by profiles.choices.');
        }
        json(response, 200, await bridge.request(parsed, controller.signal));
      } finally { response.off('close', disconnected); }
    } catch (error) {
      json(response, error instanceof HttpError ? error.status : 502, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const server = createServer((request, response) => {
    response.on('error', () => response.destroy());
    void handle(request, response);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = 64;
  const close = () => closing ??= (async () => {
    stopping = true;
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    await bridge.close();
    for (const stream of streams) stream.end();
    // The CLI has flushed; only stalled network clients are force-closed after this grace period.
    const timer = setTimeout(() => server.closeAllConnections(), 5000);
    try { await stopped; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', aborted); }
  })();
  const aborted = () => { void close(); };
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  bridge.on('failure', error => { failure = error; void close(); });
  bridge.on('closed', () => { void close(); });
  server.on('error', error => { failure = error; void close(); });
  try {
    await bridge.ready;
    signal?.throwIfAborted();
    if (stopping) throw failure ?? new Error('Host stopped before listening.');
    await new Promise<void>((resolve, reject) => {
      const cancelled = () => reject(signal!.reason);
      signal?.addEventListener('abort', cancelled, { once: true });
      const finished = (error?: Error) => {
        signal?.removeEventListener('abort', cancelled); server.off('error', finished);
        if (error) reject(error); else resolve();
      };
      server.once('error', finished);
      server.listen(port, '127.0.0.1', () => finished());
    });
    signal?.throwIfAborted();
  } catch (error) { await close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') { await close(); throw new Error('Host did not start.'); }
  origin = `http://127.0.0.1:${address.port}`;
  const closed = bridge.closed.then(async () => { await close(); if (failure ?? bridge.failure) throw failure ?? bridge.failure; });
  void closed.catch(() => {});
  return { url: origin, token, cwd, stateDir, demo, child: bridge.child, closed, close };
}

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { requestSchema } from '../src/protocol.js';
import { Bridge, type ProtocolEvent, type Request } from './bridge.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function startHost(options: { cwd: string; port?: number; stateDir?: string; demo?: boolean }) {
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
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) throw new HttpError(401, 'Bearer token required.');
      if (stopping || bridge.failure) throw new HttpError(503, 'Host is stopping.');
      const url = new URL(request.url ?? '/', origin);
      if (url.origin !== origin || url.search) throw new HttpError(400, 'Unexpected URL or query parameters.');
      if (request.method === 'GET' && url.pathname === '/api/host') {
        json(response, 200, { cwd, stateDir, demo, methods: (await bridge.ready).methods }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        if (streams.size >= 16) throw new HttpError(429, 'Too many event streams.');
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
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
    server.closeAllConnections();
    await stopped;
  })();
  bridge.on('failure', () => { void close(); });
  bridge.on('closed', () => { void close(); });
  try {
    await bridge.ready;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { await close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') { await close(); throw new Error('Host did not start.'); }
  origin = `http://127.0.0.1:${address.port}`;
  const closed = bridge.closed.then(async () => { await close(); if (bridge.failure) throw bridge.failure; });
  void closed.catch(() => {});
  return { url: origin, token, cwd, stateDir, demo, child: bridge.child, closed, close };
}

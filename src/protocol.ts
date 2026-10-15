import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { SessionManager } from './application.js';
import { redact, type Engine } from './engine.js';

const sessionId = z.uuid();
const ref = z.string().min(1).max(4096);
const methods = {
  'profiles.list': z.object({}).strict(),
  'profiles.choices': z.object({}).strict(),
  'session.list': z.object({}).strict(),
  'session.create': z.object({ title: z.string().trim().min(1).max(160).optional(), orchestrator: ref.optional(), workers: z.array(ref).max(32).optional(), direct: ref.optional() }).strict(),
  'session.open': z.object({ sessionId: z.union([sessionId, z.literal('latest')]) }).strict(),
  'session.get': z.object({ sessionId }).strict(),
  'session.rename': z.object({ sessionId, title: z.string().trim().min(1).max(160) }).strict(),
  'session.submit': z.object({ sessionId, text: z.string().trim().min(1).max(16000) }).strict(),
  'session.stop': z.object({ sessionId }).strict(),
  'session.pause': z.object({ sessionId }).strict(),
  'session.resume': z.object({ sessionId }).strict(),
  'session.retry': z.object({ sessionId, taskId: z.string().max(200).optional() }).strict(),
  'session.assign': z.object({ sessionId, taskId: z.string().min(1).max(200), profileId: z.string().min(1).max(80) }).strict(),
  'request.respond': z.object({ sessionId, requestId: z.uuid(), answer: z.string().max(16000) }).strict(),
};
export const requestSchema = z.object({ version: z.literal(1), id: z.string().min(1).max(128),
  method: z.enum(Object.keys(methods) as [keyof typeof methods, ...Array<keyof typeof methods>]), params: z.unknown() }).strict();

export async function serveStdio(manager: SessionManager, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  let engine: Engine | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let dirty = false;
  let closed = false;
  const operations = new Set<Promise<void>>();
  const send = (value: unknown) => { if (!closed) output.write(JSON.stringify(value, (_key, v) => typeof v === 'string' ? redact(v) : v) + '\n'); };
  const state = () => {
    timer = undefined;
    if (!engine || !dirty || output.writableNeedDrain) return;
    dirty = false;
    send({ version: 1, event: 'session.state', sequence: ++sequence, sessionId: engine.state.session.id, state: engine.state });
  };
  const changed = () => { dirty = true; if (!timer) timer = setTimeout(state, 50); };
  const attach = (next: Engine) => {
    engine?.off('change', changed);
    engine = next; engine.on('change', changed); changed();
    return engine.state;
  };
  const launch = (work: () => Promise<void>) => {
    const current = engine!;
    const pending = work().catch(error => send({ version: 1, event: 'operation.error', sessionId: current.state.session.id,
      error: error instanceof Error ? error.message : String(error) })).finally(() => { operations.delete(pending); changed(); });
    operations.add(pending);
    return { accepted: true };
  };
  const handle = async (line: string) => {
    let requestId: string | null = null;
    try {
      const raw: unknown = JSON.parse(line);
      if (raw && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string') requestId = raw.id.slice(0, 128);
      const request = requestSchema.parse(raw);
      const params = methods[request.method].parse(request.params ?? {}) as Record<string, unknown>;
      let result: unknown;
      switch (request.method) {
        case 'profiles.list': result = (await manager.profiles()).map(p => ({ ...p.manifest, source: p.root, checksum: p.checksum })); break;
        case 'profiles.choices': result = (await manager.choices()).map(({ reference, profile }) => ({ reference, ...profile.manifest, source: profile.root, checksum: profile.checksum, image: profile.image })); break;
        case 'session.list': result = (await manager.list()).map(({ session, modified }) => ({ id: session.id, title: session.title, demo: session.demo,
          updatedAt: session.updatedAt ?? new Date(modified).toISOString(), configuration: session.configuration })); break;
        case 'session.create': result = attach(await manager.create(params)); break;
        case 'session.open': result = attach(await manager.open(params.sessionId as string)); break;
        default: {
          if (!engine || engine.state.session.id !== params.sessionId) throw new Error('Open this session before sending commands to it.');
          switch (request.method) {
            case 'session.get': result = engine.state; break;
            case 'session.rename': await engine.rename(params.title as string); break;
            case 'session.submit':
              if (engine.state.request) throw new Error('Reply using request.respond and the active requestId.');
              result = launch(() => engine!.submit(params.text as string)); break;
            case 'session.stop': engine.stop(); break;
            case 'session.pause': engine.pause(); await engine.flush(); break;
            case 'session.resume': result = launch(() => engine!.resume()); break;
            case 'session.retry': result = launch(() => engine!.retry(params.taskId as string | undefined)); break;
            case 'session.assign': engine.assign(params.taskId as string, params.profileId as string); await engine.flush(); break;
            case 'request.respond': engine.answer(params.answer as string, params.requestId as string); break;
          }
        }
      }
      send({ version: 1, id: request.id, ok: true, result: result ?? null });
    } catch (error) { send({ version: 1, id: requestId, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  };
  output.on('drain', state);
  const stop = () => { engine?.stop(); input.destroy(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  input.setEncoding('utf8');
  let buffer = '', discarding = false;
  try {
    send({ version: 1, event: 'ready', methods: Object.keys(methods) });
    for await (const chunk of input) {
      // Limit each line, including unterminated input, without buffering the entire request stream.
      for (const part of String(chunk).split(/(?<=\n)/)) {
        const ended = part.endsWith('\n');
        if (!discarding && Buffer.byteLength(buffer) + Buffer.byteLength(part) > 65536) {
          send({ version: 1, id: null, ok: false, error: 'Request exceeds 64 KiB.' }); buffer = ''; discarding = true;
        }
        if (!discarding) buffer += part;
        if (ended) { if (!discarding && buffer.trim()) await handle(buffer); buffer = ''; discarding = false; }
      }
    }
    if (!discarding && buffer.trim()) await handle(buffer);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ERR_STREAM_PREMATURE_CLOSE')) throw error;
  } finally {
    try {
      await manager.shutdown();
      await Promise.all(operations);
      dirty = true; state();
    } finally {
      clearTimeout(timer); closed = true;
      engine?.off('change', changed); output.off('drain', state);
      process.off('SIGTERM', stop); process.off('SIGINT', stop);
    }
  }
}

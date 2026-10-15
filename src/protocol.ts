import type { Readable, Writable } from 'node:stream';
import { SessionManager } from './application.js';
import { redact, type Engine } from './engine.js';
import { parseRequest, protocolMethods, type ProtocolMessage, type ProtocolMethod, type ProtocolResults } from './contracts.js';
export { requestSchema } from './contracts.js';

export async function serveStdio(manager: SessionManager, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  let engine: Engine | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let dirty = false;
  let closed = false;
  const operations = new Set<Promise<void>>();
  const send = (value: ProtocolMessage) => { if (!closed) output.write(JSON.stringify(value, (_key, v) => typeof v === 'string' ? redact(v) : v) + '\n'); };
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
    return { accepted: true } as const;
  };
  const handle = async (line: string) => {
    let requestId: string | null = null;
    try {
      const raw: unknown = JSON.parse(line);
      if (raw && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string') requestId = raw.id.slice(0, 128);
      const request = parseRequest(raw);
      const { method, params } = request;
      let result: ProtocolResults[ProtocolMethod] | undefined;
      switch (method) {
        case 'profiles.list': result = (await manager.profiles()).map(p => ({ ...p.manifest, source: p.root, checksum: p.checksum })); break;
        case 'profiles.choices': result = (await manager.choices()).map(({ reference, profile }) => ({ reference, ...profile.manifest, source: profile.root, checksum: profile.checksum, image: profile.image })); break;
        case 'profiles.readiness': {
          // Native setup probes can take seconds; keep stop/approval requests responsive.
          const pending = manager.readiness(params.reference).then(
            result => { send({ version: 1, id: request.id, ok: true, result }); },
            error => { send({ version: 1, id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }); },
          ).finally(() => { operations.delete(pending); });
          operations.add(pending);
          return;
        }
        case 'session.list': result = (await manager.list()).map(({ session, modified }) => ({ id: session.id, title: session.title, demo: session.demo,
          updatedAt: session.updatedAt ?? new Date(modified).toISOString(), configuration: session.configuration })); break;
        case 'session.create': result = attach(await manager.create(params)); break;
        case 'session.open': result = attach(await manager.open(params.sessionId)); break;
        default: {
          if (!engine || engine.state.session.id !== params.sessionId) throw new Error('Open this session before sending commands to it.');
          switch (method) {
            case 'session.get': result = engine.state; break;
            case 'session.rename': await engine.rename(params.title); break;
            case 'session.submit':
              if (engine.state.request) throw new Error('Reply using request.respond and the active requestId.');
              result = launch(() => engine!.submit(params.text)); break;
            case 'session.stop': engine.stop(); break;
            case 'session.pause': engine.pause(); await engine.flush(); break;
            case 'session.resume': result = launch(() => engine!.resume()); break;
            case 'session.retry': result = launch(() => engine!.retry(params.taskId)); break;
            case 'session.assign': engine.assign(params.taskId, params.profileId); await engine.flush(); break;
            case 'request.respond': engine.answer(params.answer, params.requestId); break;
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
    send({ version: 1, event: 'ready', methods: protocolMethods });
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

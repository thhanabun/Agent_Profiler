import type { ProtocolEvent, ProtocolMethod, ProtocolRequest, ProtocolResponse, ProtocolResults, View } from '../../src/contracts.js';

export type Bootstrap = {
  token: string;
  project: { name: string; cwd: string };
  mode: 'live' | 'demo';
  ready: boolean;
};
export type HostEvent = ProtocolEvent | { event: 'host.error'; error: string };
export type RequestParams<M extends ProtocolMethod> = Extract<ProtocolRequest, { method: M }>['params'];
export function sameHost(previous: Bootstrap, next: Bootstrap): boolean {
  return previous.token === next.token && previous.mode === next.mode &&
    previous.project.cwd === next.project.cwd && previous.project.name === next.project.name;
}

export class MissionApiError extends Error {
  constructor(message: string, readonly status?: number, readonly kind: 'network' | 'http' | 'protocol' | 'host' | 'auth' | 'reconnect' = 'protocol') {
    super(message);
    this.name = 'MissionApiError';
  }
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';
export function isView(value: unknown): value is View {
  return object(value) && object(value.session) && typeof value.session.id === 'string' &&
    Array.isArray(value.session.messages) && Array.isArray(value.session.tasks) &&
    typeof value.busy === 'boolean' && typeof value.output === 'string' && typeof value.phase === 'string' &&
    typeof value.paused === 'boolean' && typeof value.status === 'string';
}

function eventFrom(value: unknown): HostEvent {
  if (!object(value)) throw new MissionApiError('The local host sent an invalid event.');
  if (value.event === 'host.error' && typeof value.error === 'string') return value as HostEvent;
  if (value.version !== 1) throw new MissionApiError('The local host uses an unsupported protocol version.');
  if (value.event === 'ready' && Array.isArray(value.methods) && value.methods.every(method => typeof method === 'string')) return value as HostEvent;
  if (value.event === 'operation.error' && typeof value.sessionId === 'string' && typeof value.error === 'string') return value as HostEvent;
  if (value.event === 'session.state' && typeof value.sessionId === 'string' && Number.isSafeInteger(value.sequence) &&
      Number(value.sequence) >= 0 && isView(value.state) && value.state.session.id === value.sessionId) return value as HostEvent;
  throw new MissionApiError('The local host sent an invalid session event.');
}

/** Decode fetch-based SSE without placing the authentication token in a URL. */
export async function readEventStream(stream: ReadableStream<Uint8Array>, onEvent: (event: HostEvent) => void, signal?: AbortSignal): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const maximum = 16 * 1024 * 1024;
  let buffer = '';
  let data: string[] = [];
  let size = 0;
  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join('\n');
    data = []; size = 0;
    let value: unknown;
    try { value = JSON.parse(payload); }
    catch { throw new MissionApiError('The local host sent an unreadable event. Reconnect and try again.'); }
    onEvent(eventFrom(value));
  };
  const line = (value: string) => {
    if (!value) { dispatch(); return; }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    if ((colon < 0 ? value : value.slice(0, colon)) !== 'data') return;
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    size += content.length;
    if (size > maximum) throw new MissionApiError('The local host event exceeds the browser size limit.');
    data.push(content);
  };
  const consume = (final = false) => {
    let start = 0;
    for (let index = 0; index < buffer.length; index++) {
      const char = buffer[index];
      if (char !== '\r' && char !== '\n') continue;
      if (char === '\r' && index === buffer.length - 1 && !final) break;
      line(buffer.slice(start, index));
      if (char === '\r' && buffer[index + 1] === '\n') index++;
      start = index + 1;
    }
    buffer = buffer.slice(start);
    if (buffer.length > maximum) throw new MissionApiError('The local host event exceeds the browser size limit.');
    if (final && buffer) { line(buffer); buffer = ''; }
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consume();
    }
    buffer += decoder.decode();
    consume(true);
    dispatch();
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class MissionApi {
  private token: string | null = null;
  private bootstrapSequence = 0;
  private acceptedBootstrap = 0;
  private latestBootstrap: Bootstrap | null = null;
  private legacy = false;
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis), private readonly base = '') {}

  setToken(token: string): void {
    if (!token.trim()) throw new MissionApiError('Enter the local host token printed in your terminal.', 401, 'auth');
    this.token = token.trim();
    this.latestBootstrap = null;
    this.acceptedBootstrap = ++this.bootstrapSequence;
  }

  private async request(path: string, options: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(`${this.base}${path}`, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', ...options });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new MissionApiError('Cannot reach the local Mission host. Check that it is running, then reconnect.', undefined, 'network');
    }
  }
  private async json(response: Response): Promise<unknown> {
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      throw new MissionApiError('The local host token is missing or expired. Enter the current token from your terminal.', 401, 'auth');
    }
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new MissionApiError(`The local host returned an unreadable response (${response.status}).`, response.status); }
    if (!response.ok) {
      const reason = object(value) && typeof value.error === 'string' ? value.error : `The local host request failed (${response.status}).`;
      throw new MissionApiError(reason, response.status, 'http');
    }
    return value;
  }
  private async authenticated(path: string, options: RequestInit): Promise<Response> {
    const automatic = !this.legacy && this.latestBootstrap !== null;
    const response = await this.request(path, options);
    if (response.status === 401 && automatic) {
      await response.body?.cancel().catch(() => {});
      await this.bootstrap(options.signal ?? undefined);
      throw new MissionApiError('The local host connection was refreshed. Reconnect before continuing; the last request was not replayed.', 401, 'reconnect');
    }
    return response;
  }
  async bootstrap(signal?: AbortSignal): Promise<Bootstrap> {
    const sequence = ++this.bootstrapSequence;
    const response = await this.request('/api/bootstrap', { headers: { Accept: 'application/json' }, signal });
    let value: unknown;
    let legacy = false;
    if (response.status === 401 || response.status === 404) {
      await response.body?.cancel().catch(() => {});
      const token = this.token;
      if (!token) throw new MissionApiError('Enter the local host token printed in your terminal to connect.', 401, 'auth');
      const host = await this.json(await this.request('/api/host', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal,
      }));
      if (!object(host) || typeof host.cwd !== 'string' || !host.cwd || typeof host.stateDir !== 'string' ||
          typeof host.demo !== 'boolean' || !Array.isArray(host.methods) || !host.methods.every(method => typeof method === 'string')) {
        throw new MissionApiError('The local host returned invalid project information.');
      }
      const name = host.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) || host.cwd;
      value = { token, project: { name, cwd: host.cwd }, mode: host.demo ? 'demo' : 'live', ready: true };
      legacy = true;
    } else value = await this.json(response);
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (!object(value) || typeof value.token !== 'string' || !value.token || !object(value.project) ||
        typeof value.project.name !== 'string' || typeof value.project.cwd !== 'string' ||
        (value.mode !== 'live' && value.mode !== 'demo') || typeof value.ready !== 'boolean') {
      throw new MissionApiError('The local host returned invalid startup information.');
    }
    if (sequence < this.acceptedBootstrap) {
      if (this.latestBootstrap) return this.latestBootstrap;
      throw new DOMException('Connection credentials changed.', 'AbortError');
    }
    this.acceptedBootstrap = sequence;
    this.latestBootstrap = value as Bootstrap;
    this.token = value.token;
    this.legacy = legacy;
    return this.latestBootstrap;
  }
  async rpc<M extends ProtocolMethod>(method: M, params: RequestParams<M>, signal?: AbortSignal): Promise<ProtocolResults[M]> {
    if (!this.token) throw new MissionApiError('Enter the local host token before sending a command.', 401, 'auth');
    const id = globalThis.crypto.randomUUID();
    const request = { version: 1, id, method, params } as ProtocolRequest;
    const value = await this.json(await this.authenticated(this.legacy ? `/api/${method}` : '/api/rpc', {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request), signal,
    }));
    if (!object(value) || value.version !== 1 || value.id !== id || typeof value.ok !== 'boolean') {
      throw new MissionApiError('The local host returned a response for a different command.');
    }
    const response = value as ProtocolResponse<M>;
    if (!response.ok) throw new MissionApiError(response.error);
    if (!('result' in response)) throw new MissionApiError('The local host omitted the command result.');
    return response.result;
  }
  async events(options: { signal: AbortSignal; onOpen?: () => void; onEvent: (event: HostEvent) => void }): Promise<void> {
    if (!this.token) throw new MissionApiError('Enter the local host token before opening its event stream.', 401, 'auth');
    const response = await this.authenticated('/api/events', {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' }, signal: options.signal,
    });
    if (!response.ok) { await this.json(response); return; }
    if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
      throw new MissionApiError('The local host did not open a session event stream.');
    }
    options.onOpen?.();
    await readEventStream(response.body, options.onEvent, options.signal);
    if (!options.signal.aborted) throw new MissionApiError('The connection to the local Mission host closed. Reconnecting…', undefined, 'network');
  }
}

/** Full snapshots replace the view. Sequence and selection guards prevent stale-session output. */
export class SessionSnapshots {
  sequence = -1;
  generation = 0;
  hostEpoch = 0;
  activeId: string | null = null;
  private selection?: { generation: number; baseline: number };
  private readonly latest = new Map<string, { sequence: number; state: View }>();
  get switching(): boolean { return Boolean(this.selection); }
  resetHost(): void {
    this.sequence = -1;
    this.activeId = null;
    this.latest.clear();
    this.selection = undefined;
    this.generation++;
    this.hostEpoch++;
  }
  accept(event: Extract<ProtocolEvent, { event: 'session.state' }>, hostEpoch = this.hostEpoch): View | null {
    if (hostEpoch !== this.hostEpoch || event.sessionId !== event.state.session.id || event.sequence <= this.sequence) return null;
    this.sequence = event.sequence;
    this.latest.set(event.sessionId, { sequence: event.sequence, state: event.state });
    if (this.latest.size > 40) {
      const oldest = [...this.latest.keys()].find(id => id !== this.activeId && id !== event.sessionId);
      if (oldest) this.latest.delete(oldest);
    }
    if (this.selection || (this.activeId && this.activeId !== event.sessionId)) return null;
    this.activeId = event.sessionId;
    return event.state;
  }
  beginSelection(): number {
    if (this.selection) throw new MissionApiError('A conversation is already being opened. Please wait.');
    const generation = ++this.generation;
    this.selection = { generation, baseline: this.sequence };
    return generation;
  }
  finishSelection(state: View, generation: number): View | null {
    if (this.selection?.generation !== generation) return null;
    const cached = this.latest.get(state.session.id);
    const result = cached && cached.sequence > this.selection.baseline ? cached.state : state;
    this.activeId = state.session.id;
    this.latest.set(state.session.id, { sequence: this.sequence, state: result });
    this.selection = undefined;
    return result;
  }
  cancelSelection(generation: number): View | null {
    if (this.selection?.generation !== generation) return null;
    this.selection = undefined;
    return this.activeId ? this.latest.get(this.activeId)?.state ?? null : null;
  }
  refreshed(state: View, sessionId: string, sequence: number, generation: number): View | null {
    if (this.selection || generation !== this.generation || sessionId !== this.activeId || state.session.id !== sessionId) return null;
    if ((this.latest.get(sessionId)?.sequence ?? -1) > sequence) return null;
    this.latest.set(sessionId, { sequence: this.sequence, state });
    return state;
  }
}

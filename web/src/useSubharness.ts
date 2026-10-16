import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProfileChoiceSummary, ProfileReadiness, ProtocolRequest, ProtocolResults, View } from '../../src/contracts.js';
import { isView, sameHost, HostApi, HostApiError, SessionSnapshots, type Bootstrap, type RequestParams } from './api.js';

export type CreateParams = Extract<ProtocolRequest, { method: 'session.create' }>['params'];
export type SubharnessCommand = 'session.stop' | 'session.pause' | 'session.resume' | 'session.retry' | 'session.assign' | 'request.respond' | 'session.rename';
export type CommandParams<M extends SubharnessCommand> = Omit<RequestParams<M>, 'sessionId'>;
type CommandArguments<M extends SubharnessCommand> = {} extends CommandParams<M> ? [params?: CommandParams<M>] : [params: CommandParams<M>];
export type SubharnessController = {
  bootstrap: Bootstrap | null;
  connection: 'connecting' | 'connected' | 'reconnecting' | 'offline';
  view: View | null;
  sessions: ProtocolResults['session.list'];
  profiles: ProfileChoiceSummary[];
  readiness: Record<string, ProfileReadiness>;
  error: string | null;
  pending: boolean;
  requiresToken: boolean;
  connectToken(token: string): void;
  isCurrentHost(expected: Bootstrap): boolean;
  clearError(): void;
  refresh(): Promise<void>;
  checkProfiles(references: string[]): Promise<ProfileReadiness[]>;
  create(params: CreateParams): Promise<View>;
  open(id: string): Promise<View>;
  submit(text: string): Promise<void>;
  command<M extends SubharnessCommand>(method: M, ...args: CommandArguments<M>): Promise<void>;
};

const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
const aborted = (error: unknown, signal?: AbortSignal) => signal?.aborted || (error instanceof Error && error.name === 'AbortError');
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function useSubharness(): SubharnessController {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [connection, setConnection] = useState<SubharnessController['connection']>('connecting');
  const [view, setView] = useState<View | null>(null);
  const [sessions, setSessions] = useState<ProtocolResults['session.list']>([]);
  const [profiles, setProfiles] = useState<ProfileChoiceSummary[]>([]);
  const [readiness, setReadiness] = useState<Record<string, ProfileReadiness>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [requiresToken, setRequiresToken] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const api = useRef<HostApi | null>(null);
  if (!api.current) api.current = new HostApi();
  const snapshots = useRef(new SessionSnapshots());
  const life = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const pendingCount = useRef(0);
  const startup = useRef<Bootstrap | null>(null);
  const connectionError = useRef<string | null>(null);
  const readinessError = useRef<string | null>(null);
  const hostRequests = useRef<AbortController | null>(null);
  if (!hostRequests.current) hostRequests.current = new AbortController();

  const requireToken = useCallback((failure: unknown): boolean => {
    if (!(failure instanceof HostApiError) || failure.kind !== 'auth') return false;
    if (mounted.current) {
      setRequiresToken(true);
      setConnection('offline');
      setError(failure.message);
      life.current?.abort();
    }
    return true;
  }, []);
  const connectToken = useCallback((token: string) => {
    api.current!.setToken(token);
    life.current?.abort();
    setRequiresToken(false);
    setConnection('connecting');
    setError(null);
    setConnectionAttempt(attempt => attempt + 1);
  }, []);
  const isCurrentHost = useCallback((expected: Bootstrap) => Boolean(startup.current && sameHost(startup.current, expected)), []);
  const reconnect = useCallback((failure: unknown): boolean => {
    if (!(failure instanceof HostApiError) || failure.kind !== 'reconnect') return false;
    if (mounted.current) {
      connectionError.current = failure.message;
      setConnection('reconnecting');
      setError(failure.message);
      life.current?.abort();
      setConnectionAttempt(attempt => attempt + 1);
    }
    return true;
  }, []);

  const replace = useCallback((next: View) => {
    if (!mounted.current) return;
    setView(next);
    setSessions(current => {
      const entry = { id: next.session.id, title: next.session.title, demo: next.session.demo,
        updatedAt: next.session.updatedAt ?? next.session.createdAt ?? new Date().toISOString(), configuration: next.session.configuration };
      const rows = current.some(item => item.id === entry.id) ? current.map(item => item.id === entry.id ? entry : item) : [entry, ...current];
      return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }, []);
  const acceptBootstrap = useCallback((next: Bootstrap) => {
    if (!mounted.current) return;
    if (startup.current && !sameHost(startup.current, next)) {
      snapshots.current.resetHost();
      hostRequests.current!.abort();
      hostRequests.current = new AbortController();
      setView(null);
      setSessions([]);
      setProfiles([]);
      setReadiness({});
      readinessError.current = null;
      connectionError.current = null;
      setError(null);
    }
    startup.current = next;
    setBootstrap(next);
  }, []);
  const track = useCallback(async <T,>(work: (signal?: AbortSignal) => Promise<T>): Promise<T> => {
    const epoch = snapshots.current.hostEpoch;
    const signal = AbortSignal.any([hostRequests.current!.signal, ...(life.current ? [life.current.signal] : [])]);
    if (mounted.current) { pendingCount.current++; setPending(true); }
    try { return await work(signal); }
    catch (failure) {
      if (mounted.current && epoch === snapshots.current.hostEpoch && !aborted(failure, signal) && !reconnect(failure) && !requireToken(failure)) setError(reason(failure));
      throw failure;
    } finally {
      pendingCount.current = Math.max(0, pendingCount.current - 1);
      if (mounted.current) setPending(pendingCount.current > 0);
    }
  }, [reconnect, requireToken]);

  const refreshData = useCallback(async (signal?: AbortSignal): Promise<Bootstrap> => {
    const info = await api.current!.bootstrap(signal);
    if (signal?.aborted) return info;
    acceptBootstrap(info);
    if (!info.ready) return info;
    const epoch = snapshots.current.hostEpoch;
    const rpcSignal = AbortSignal.any([hostRequests.current!.signal, ...(signal ? [signal] : [])]);
    try {
      const [saved, choices] = await Promise.all([
        api.current!.rpc('session.list', {}, rpcSignal), api.current!.rpc('profiles.choices', {}, rpcSignal),
      ]);
      if (!mounted.current || rpcSignal.aborted || epoch !== snapshots.current.hostEpoch) return info;
      setSessions(current => {
        if (epoch !== snapshots.current.hostEpoch) return current;
        const active = current.find(item => item.id === snapshots.current.activeId);
        const fromDisk = saved.find(item => item.id === active?.id);
        if (!active || fromDisk && fromDisk.updatedAt >= active.updatedAt) return saved;
        return [active, ...saved.filter(item => item.id !== active.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      });
      setProfiles(current => epoch === snapshots.current.hostEpoch ? choices : current);
      setReadiness(current => epoch !== snapshots.current.hostEpoch ? current : Object.fromEntries(Object.entries(current).filter(([reference, check]) => {
        const choice = choices.find(item => item.reference === reference);
        return !choice || (!check.checksum || check.checksum === choice.checksum) && (!check.image || check.image.digest === choice.image?.digest);
      })));
      const current = snapshots.current;
      const id = current.activeId;
      if (id && !current.switching) {
        const sequence = current.sequence, generation = current.generation;
        const state = await api.current!.rpc('session.get', { sessionId: id }, rpcSignal);
        if (!isView(state)) throw new HostApiError('The local host returned an invalid conversation snapshot.');
        if (!rpcSignal.aborted && epoch === snapshots.current.hostEpoch) {
          const next = current.refreshed(state, id, sequence, generation);
          if (next) replace(next);
        }
      }
      return info;
    } catch (failure) {
      if (rpcSignal.aborted || epoch !== snapshots.current.hostEpoch) return info;
      throw failure;
    }
  }, [acceptBootstrap, replace]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    life.current = controller;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let syncing: Promise<void> | undefined;
    const sync = () => {
      if (syncing || controller.signal.aborted) return;
      syncing = refreshData(controller.signal).then(info => {
        if (!info.ready && !controller.signal.aborted) startupTimer = setTimeout(sync, 1000);
      }).catch(failure => {
        if (!controller.signal.aborted && !aborted(failure) && !reconnect(failure) && !requireToken(failure)) setError(reason(failure));
      }).finally(() => { syncing = undefined; });
    };
    const connect = async () => {
      let failures = 0;
      while (!controller.signal.aborted) {
        let attemptEpoch = snapshots.current.hostEpoch;
        try {
          const info = await api.current!.bootstrap(controller.signal);
          if (controller.signal.aborted) break;
          acceptBootstrap(info);
          const epoch = snapshots.current.hostEpoch;
          attemptEpoch = epoch;
          const streamSignal = AbortSignal.any([controller.signal, hostRequests.current!.signal]);
          await api.current!.events({
            signal: streamSignal,
            onOpen: () => {
              if (streamSignal.aborted || epoch !== snapshots.current.hostEpoch) return;
              setConnection('connected');
              setRequiresToken(false);
              setError(current => current === connectionError.current ? null : current);
              sync();
            },
            onEvent: event => {
              if (streamSignal.aborted || epoch !== snapshots.current.hostEpoch) return;
              if (event.event === 'host.error') {
                setConnection('offline');
                throw new HostApiError(event.error, undefined, 'host');
              }
              if (event.event === 'ready') { failures = 0; sync(); return; }
              if (event.event === 'session.state') {
                failures = 0;
                const next = snapshots.current.accept(event, epoch);
                if (next) replace(next);
              } else if (event.event === 'operation.error' && event.sessionId === snapshots.current.activeId && !snapshots.current.switching) {
                setError(event.error);
              }
            },
          });
        } catch (failure) {
          if (controller.signal.aborted) break;
          if (attemptEpoch !== snapshots.current.hostEpoch || aborted(failure)) continue;
          if (failure instanceof HostApiError && failure.kind === 'reconnect') {
            connectionError.current = failure.message;
            setConnection('reconnecting');
            setError(failure.message);
            continue;
          }
          if (requireToken(failure)) break;
          failures++;
          connectionError.current = reason(failure);
          setError(connectionError.current);
          setConnection(failure instanceof HostApiError && failure.kind === 'host' || failures >= 3 ? 'offline' : 'reconnecting');
          await wait(Math.min(8000, 500 * 2 ** Math.min(failures - 1, 4)), controller.signal);
        }
      }
    };
    void connect();
    return () => {
      mounted.current = false;
      controller.abort();
      clearTimeout(startupTimer);
      if (life.current === controller) life.current = null;
    };
  }, [acceptBootstrap, connectionAttempt, reconnect, refreshData, replace, requireToken]);

  const refresh = useCallback(() => track(async signal => { await refreshData(signal); }), [refreshData, track]);
  const checkProfiles = useCallback((references: string[]) => track(async signal => {
    const unique = [...new Set(references.filter(Boolean))];
    const results = await Promise.all(unique.map(async reference => {
      try { return await api.current!.rpc('profiles.readiness', { reference }, signal); }
      catch (failure) {
        if (aborted(failure, signal)) throw failure;
        if (failure instanceof HostApiError && (failure.kind === 'auth' || failure.kind === 'reconnect')) throw failure;
        const message = `Could not check ${reference}: ${reason(failure)}`;
        return { reference, checkedAt: new Date().toISOString(), available: false, reason: message,
          checks: [{ kind: 'source' as const, status: 'unverified' as const, reason: message,
            action: 'Check the local host connection and profile setup, then run the readiness check again.' }] } satisfies ProfileReadiness;
      }
    }));
    signal?.throwIfAborted();
    if (mounted.current && !signal?.aborted) {
      setReadiness(current => ({ ...current, ...Object.fromEntries(results.map(item => [item.reference, item])) }));
      const failed = results.filter(item => !item.available);
      const previous = readinessError.current;
      const next = startup.current?.mode !== 'demo' && failed.length
        ? failed.map(item => `${item.reference}: ${item.reason}`).join('\n') : null;
      readinessError.current = next;
      setError(current => current === null || current === previous ? next : current);
    }
    return results;
  }), [track]);

  const changeSession = useCallback((method: 'session.create' | 'session.open', params: CreateParams | { sessionId: string }) => track(async signal => {
    const current = snapshots.current;
    const generation = current.beginSelection();
    try {
      const state = method === 'session.create'
        ? await api.current!.rpc('session.create', params as CreateParams, signal)
        : await api.current!.rpc('session.open', params as { sessionId: string }, signal);
      if (!isView(state)) throw new HostApiError('The local host returned an invalid conversation snapshot.');
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const next = current.finishSelection(state, generation);
      if (!next) throw new HostApiError('The conversation changed before it finished opening. Please open it again.');
      replace(next);
      if (mounted.current) setError(null);
      return next;
    } catch (failure) {
      const previous = current.cancelSelection(generation);
      if (previous && !signal?.aborted) replace(previous);
      throw failure;
    }
  }), [replace, track]);
  const create = useCallback((params: CreateParams) => changeSession('session.create', params), [changeSession]);
  const open = useCallback((id: string) => changeSession('session.open', { sessionId: id }), [changeSession]);
  const currentSession = useCallback(() => {
    if (snapshots.current.switching) throw new HostApiError('Wait for the conversation to finish opening.');
    if (!snapshots.current.activeId) throw new HostApiError('Open or create a conversation before sending a message.');
    if (!startup.current?.ready) throw new HostApiError('The local Subharness host is not ready. Reconnect and try again.');
    return snapshots.current.activeId;
  }, []);
  const submit = useCallback((text: string) => track(async signal => {
    const trimmed = text.trim();
    if (!trimmed) throw new HostApiError('Write a message before sending.');
    if (trimmed.length > 16000) throw new HostApiError('Messages must be 16,000 characters or fewer.');
    const sessionId = currentSession();
    await api.current!.rpc('session.submit', { sessionId, text: trimmed }, signal);
    // An accepted response starts work. Only later snapshots describe its progress or completion.
  }), [currentSession, track]);
  const command = useCallback(async <M extends SubharnessCommand>(method: M, ...args: CommandArguments<M>): Promise<void> => {
    await track(async signal => {
      const sessionId = currentSession();
      await api.current!.rpc(method, { ...args[0], sessionId } as RequestParams<M>, signal);
    });
  }, [currentSession, track]);
  const clearError = useCallback(() => setError(null), []);

  return { bootstrap, connection, view, sessions, profiles, readiness, error, pending, requiresToken, connectToken, isCurrentHost, clearError, refresh, checkProfiles, create, open, submit, command };
}

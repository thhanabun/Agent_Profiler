import { spawn, execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { safePath, stageProfile } from './profiles.js';
import { stopProcess } from './process.js';
import type { RunInput, RunResult } from './adapters.js';

export async function findCodex(): Promise<string> {
  const explicit = process.env.SUBHARNESS_CODEX_BIN;
  if (explicit && /\.(?:cmd|bat|ps1)$/i.test(explicit)) throw new Error('SUBHARNESS_CODEX_BIN must point to the native executable, not a shell shim.');
  const candidates = explicit ? [path.resolve(explicit)] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
    .flatMap(directory => process.platform === 'win32' ? [path.join(directory, 'codex.exe'),
      path.join(directory, `node_modules/@openai/codex/node_modules/@openai/codex-win32-${process.arch}/vendor/${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc/codex/codex.exe`)]
      : [path.join(directory, 'codex')]);
  for (const executable of candidates) { try { await access(executable); return executable; } catch { /* Try the next native location. */ } }
  throw new Error('Codex is missing. Install the native Codex CLI, or set SUBHARNESS_CODEX_BIN to its executable. Then run `codex login`.');
}

export async function getCodexAuth(): Promise<{ available: boolean; reason: string }> {
  try {
    const executable = await findCodex();
    const { stdout, stderr } = await promisify(execFile)(executable, ['login', 'status'], { windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024 });
    if (!/logged in/i.test(stdout + stderr)) throw new Error('No native login.');
    return { available: true, reason: 'Native Codex login found; provider access is checked on the next model call.' };
  } catch { return { available: false, reason: 'Install native Codex (or set SUBHARNESS_CODEX_BIN), then run `codex login`.' }; }
}

const envelopeSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(), result: z.unknown().optional(),
  error: z.object({ message: z.string(), code: z.number().optional() }).passthrough().optional() }).passthrough();
const itemSchema = z.object({ id: z.string(), type: z.string(), text: z.string().optional(), phase: z.string().nullable().optional() }).passthrough();
const turnSchema = z.object({ id: z.string(), status: z.string(), error: z.object({ message: z.string() }).nullable().optional(), items: z.array(itemSchema).optional() }).passthrough();

// Uses the installed CLI's app-server protocol; native auth/config stay in their original home.
export async function runCodex(input: RunInput, model?: string, launch: typeof spawn = spawn): Promise<RunResult> {
  input.signal.throwIfAborted();
  if (input.profile.manifest.plugins.length) throw new Error('Packaged Codex plugins are not supported yet. Configure plugins natively or remove bundled plugins from this profile.');
  const { root } = await stageProfile(input.profile, input.stateRoot);
  const executable = await findCodex();
  input.signal.throwIfAborted();
  const child = launch(executable, ['app-server', '--listen', 'stdio://'], { cwd: input.cwd, env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', shell: false });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 0, buffer = '', stderr = '', threadId = '', turnId = '', finished = false;
  let resolveTurn!: (turn: z.infer<typeof turnSchema>) => void;
  let rejectTurn!: (error: Error) => void;
  const completion = new Promise<z.infer<typeof turnSchema>>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  // A process failure can arrive before turn/start; attach rejection handling immediately.
  void completion.catch(() => {});
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear(); rejectTurn(error);
  };
  const send = (message: unknown) => { if (!child.stdin?.writable) throw new Error('Codex input closed.'); child.stdin.write(JSON.stringify(message) + '\n'); };
  const call = (method: string, params: unknown): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out after 30 seconds.`)); }, 30000);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  };
  const planner = input.role === 'orchestrator' || (!input.role && Boolean(input.schema));
  const activeRequests = new Map<string | number, AbortController>();
  const items = new Map<string, z.infer<typeof itemSchema>>();
  const fileChanges = new Map<string, unknown[]>();
  const request = async (message: z.infer<typeof envelopeSchema>) => {
    const id = message.id!, params = message.params ?? {};
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal.addEventListener('abort', abort, { once: true });
    activeRequests.set(id, controller);
    try {
      controller.signal.throwIfAborted();
      if (params.threadId !== threadId) throw new Error('Approval does not belong to the active Codex thread.');
      const allow = async () => {
        if (planner) return false;
        const changes = message.method === 'item/fileChange/requestApproval' ? fileChanges.get(String(params.itemId)) : undefined;
        if (message.method === 'item/fileChange/requestApproval' && !changes?.length) throw new Error('Codex did not provide a file diff for this approval. No approval was granted.');
        return await input.ask('permission', `Codex · ${message.method}`, JSON.stringify({ ...params, ...(changes ? { changes } : {}) }, null, 2), controller.signal) === 'yes';
      };
      let result: unknown;
      switch (message.method) {
        case 'item/commandExecution/requestApproval': case 'item/fileChange/requestApproval':
          result = { decision: await allow() ? 'accept' : 'decline' }; break;
        case 'item/permissions/requestApproval':
          result = { permissions: await allow() ? params.permissions : {}, scope: 'turn' }; break;
        case 'item/tool/requestUserInput': {
          const questions = z.array(z.object({ id: z.string(), question: z.string(), options: z.unknown().optional() })).parse(params.questions);
          const answers: Record<string, { answers: string[] }> = {};
          for (const q of questions) answers[q.id] = { answers: [await input.ask('question', q.question, JSON.stringify(q.options ?? []), controller.signal)] };
          result = { answers }; break;
        }
        case 'mcpServer/elicitation/request':
          // shortcut: structured MCP forms need a form UI; deny until that UI exists.
          result = { action: 'decline', content: null, _meta: null }; break;
        default: send({ id, error: { code: -32601, message: `Unsupported Codex server request: ${message.method}` } }); return;
      }
      controller.signal.throwIfAborted(); send({ id, result });
    } catch (error) {
      if (!controller.signal.aborted) { send({ id, error: { code: -32603, message: 'Codex request could not be handled.' } }); fail(error instanceof Error ? error : new Error(String(error))); }
    } finally { input.signal.removeEventListener('abort', abort); activeRequests.delete(id); }
  };
  const received = (line: string) => {
    const message = envelopeSchema.parse(JSON.parse(line));
    if (message.method && message.id !== undefined) { void request(message).catch(error => fail(error instanceof Error ? error : new Error(String(error)))); return; }
    if (!message.method && typeof message.id === 'number') {
      const waiting = pending.get(message.id); if (!waiting) return;
      clearTimeout(waiting.timer); pending.delete(message.id);
      if (message.error) waiting.reject(new Error(`Codex: ${message.error.message}`)); else waiting.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    if (params.threadId !== threadId) return;
    if (message.method === 'serverRequest/resolved') {
      const id = params.requestId;
      if (typeof id === 'number' || typeof id === 'string') activeRequests.get(id)?.abort();
    }
    if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') input.onEvent({ kind: 'text', text: params.delta });
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = itemSchema.parse(params.item);
      if (item.type === 'fileChange') fileChanges.set(item.id, z.object({ changes: z.array(z.object({ path: z.string(), kind: z.unknown(), diff: z.string() })) }).parse(item).changes);
      if (item.type === 'agentMessage' && message.method === 'item/completed') items.set(item.id, item);
      else if (item.type !== 'reasoning') input.onEvent({ kind: 'activity', text: `Codex · ${item.type}${typeof item.command === 'string' ? ` · ${item.command.slice(0, 300)}` : ''}` });
    }
    if (message.method === 'turn/completed') { const turn = turnSchema.parse(params.turn); if (!turnId || turn.id === turnId) resolveTurn(turn); }
  };
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    try {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error('Codex message exceeds 8 MiB.'); buffer = buffer.slice(index + 1); if (line.trim()) received(line); }
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) throw new Error('Codex message exceeds 8 MiB.');
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  child.stdin!.on('error', fail); child.on('error', fail);
  child.on('exit', code => { if (!finished) fail(new Error(`Codex exited (${code}). ${stderr.slice(-1600)}`)); });
  const abort = () => {
    if (threadId && turnId) void call('turn/interrupt', { threadId, turnId }).catch(() => {});
    fail(new Error('Stopped.'));
  };
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    if (input.signal.aborted) abort();
    await call('initialize', { clientInfo: { name: 'subharness', title: 'Subharness', version: '0.1.0' } });
    send({ method: 'initialized', params: {} });
    if (input.profile.manifest.skills.length) await call('skills/extraRoots/set', { extraRoots: [...new Set(input.profile.manifest.skills.map(skill => path.dirname(safePath(root, skill))))] });
    const options = { cwd: input.cwd, ...(model ? { model } : {}), approvalPolicy: 'untrusted', sandbox: planner ? 'read-only' : 'workspace-write' };
    const response = await call(input.sessionId ? 'thread/resume' : 'thread/start', { ...options, ...(input.sessionId ? { threadId: input.sessionId, excludeTurns: true } : {}) });
    threadId = z.object({ thread: z.object({ id: z.string().min(1) }) }).parse(response).thread.id;
    input.onEvent({ kind: 'session', text: '', sessionId: threadId });
    const skills: Array<{ type: 'skill'; name: string; path: string }> = [];
    if (input.profile.manifest.skills.length) {
      const catalog = z.object({ data: z.array(z.object({ skills: z.array(z.object({ name: z.string(), path: z.string(), enabled: z.boolean() })) })) }).parse(await call('skills/list', { cwds: [input.cwd], forceReload: true }));
      for (const skill of input.profile.manifest.skills) {
        const file = safePath(root, `${skill}/SKILL.md`);
        const native = catalog.data.flatMap(entry => entry.skills).find(entry => path.resolve(entry.path) === path.resolve(file));
        if (!native?.enabled) throw new Error(`Codex skill failed to load or is disabled: ${skill}. Check SKILL.md metadata and native skill policy.`);
        skills.push({ type: 'skill', name: native.name, path: file });
      }
      input.onEvent({ kind: 'activity', text: `Codex skills loaded: ${skills.map(skill => skill.name).join(', ')}` });
    }
    const started = await call('turn/start', { threadId, input: [{ type: 'text', text: `PROFILE INSTRUCTIONS (preserve project instructions and machine policies):\n${input.profile.manifest.instructions}\n\n${input.prompt}`, text_elements: [] }, ...skills], ...(input.schema ? { outputSchema: input.schema } : {}) });
    turnId = z.object({ turn: z.object({ id: z.string() }) }).parse(started).turn.id;
    input.signal.throwIfAborted();
    const turn = await completion;
    input.signal.throwIfAborted();
    if (failure) throw failure;
    if (turn.status !== 'completed') throw new Error(turn.error?.message ?? `Codex turn ${turn.status}.`);
    for (const item of turn.items ?? []) if (item.type === 'agentMessage') items.set(item.id, item);
    const final = [...items.values()].filter(item => item.phase === 'final_answer');
    const text = (final.length ? final : [...items.values()]).map(item => item.text ?? '').join('\n');
    if (!text.trim()) throw new Error('Codex returned no final answer.');
    return { text, sessionId: threadId };
  } finally {
    finished = true;
    input.signal.removeEventListener('abort', abort);
    for (const controller of activeRequests.values()) controller.abort();
    fail(new Error('Codex connection closed.'));
    child.stdin?.end();
    await stopProcess(child);
  }
}

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOpencodeClient, type Config, type Event } from '@opencode-ai/sdk/v2';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { safePath, stageProfile } from './profiles.js';
import type { LoadedProfile } from './schema.js';
import { stopProcess } from './process.js';
import { findCodex, getCodexAuth, runCodex } from './codex.js';
import { getClaudeAuth, claudeCloudConfigured, findClaude } from './auth.js';
import type { Availability, ReadinessCheck } from './contracts.js';
export type { Availability } from './contracts.js';

export type Ask = (kind: 'permission' | 'trust' | 'question', title: string, detail: string, signal: AbortSignal) => Promise<string>;
export type HarnessEvent = { kind: 'text' | 'activity' | 'session'; text: string; sessionId?: string };
export type RunInput = {
  profile: LoadedProfile;
  cwd: string;
  stateRoot: string;
  prompt: string;
  sessionId?: string;
  signal: AbortSignal;
  schema?: Record<string, unknown>;
  role?: 'orchestrator' | 'worker';
  workerProfileIds?: string[];
  ask: Ask;
  onEvent: (event: HarnessEvent) => void;
};
export type RunResult = { text: string; sessionId: string; structured?: unknown };
export type Runner = (input: RunInput) => Promise<RunResult>;

export function modelFor(profile: LoadedProfile): string | undefined {
  const key = `WORKERDECK_MODEL_${profile.manifest.id.toUpperCase().replaceAll('-', '_')}`;
  return process.env[key] || profile.manifest.model;
}

export async function findOpenCode(): Promise<string> {
  if (process.env.WORKERDECK_OPENCODE_BIN) {
    const executable = path.resolve(process.env.WORKERDECK_OPENCODE_BIN);
    if (/\.(?:cmd|bat|ps1)$/i.test(executable)) throw new Error('WORKERDECK_OPENCODE_BIN must point to the native executable, not a shell shim.');
    await access(executable);
    return executable;
  }
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidates = process.platform === 'win32'
      ? [path.join(directory, 'opencode.exe'), path.join(directory, 'node_modules/opencode-ai/bin/opencode.exe')]
      : [path.join(directory, 'opencode')];
    for (const candidate of candidates) {
      try { await access(candidate); return candidate; } catch { /* Try the next PATH location. */ }
    }
  }
  throw new Error('OpenCode is missing. Install opencode-ai, authenticate with `opencode`, then run `workerdeck doctor`.');
}


export async function runOpenCode(input: RunInput, launch: typeof spawn = spawn): Promise<RunResult> {
  input.signal.throwIfAborted();
  const { root, skillPlugin } = await stageProfile(input.profile, input.stateRoot);
  input.signal.throwIfAborted();
  const password = randomBytes(24).toString('hex');
  const planner = input.role === 'orchestrator' || (!input.role && Boolean(input.schema));
  const config: Config = {
    autoupdate: false,
    skills: { paths: [path.join(skillPlugin, 'skills')] },
    plugin: input.profile.manifest.plugins.map(plugin => pathToFileURL(safePath(root, plugin)).href),
    agent: { relay: {
      mode: 'primary',
      prompt: input.profile.manifest.instructions,
      steps: planner ? 12 : 60,
      ...(planner ? { permission: { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', structured_output: 'allow' },
        tools: { bash: false, edit: false, write: false, apply_patch: false, task: false, question: false, webfetch: false } } : {}),
    } },
  };
  const env = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'workerdeck' };
  const executable = await findOpenCode();
  input.signal.throwIfAborted();
  const child = launch(executable, ['serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd: input.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', shell: false,
  });
  const stop = () => { void stopProcess(child); };
  input.signal.addEventListener('abort', stop, { once: true });
  let startupLog = '';
  let eventController: AbortController | undefined;
  let events: Promise<void> | undefined;
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('OpenCode did not start within 30 seconds. Check `opencode --version` and configuration.')); }, 30000);
      const onAbort = () => { cleanup(); reject(new Error('Stopped.')); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onExit = (code: number | null) => { cleanup(); reject(new Error(`OpenCode exited (${code}): ${startupLog.slice(-1600)}`)); };
      const onData = (chunk: Buffer) => {
        startupLog = (startupLog + chunk.toString()).slice(-10000);
        const match = startupLog.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { cleanup(); resolve(match[1]!); }
      };
      const cleanup = () => {
        clearTimeout(timer);
        input.signal.removeEventListener('abort', onAbort);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        child.stdout?.removeListener('data', onData);
        child.stderr?.removeListener('data', onData);
      };
      child.once('error', onError);
      child.once('exit', onExit);
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      input.signal.addEventListener('abort', onAbort, { once: true });
      if (input.signal.aborted) onAbort();
    });
    // Keep pipes drained after startup so a long tool result cannot block the child process.
    child.stdout?.resume();
    child.stderr?.resume();
    child.on('error', () => {});
    const client = createOpencodeClient({ baseUrl: url, directory: input.cwd,
      headers: { Authorization: `Basic ${Buffer.from(`workerdeck:${password}`).toString('base64')}` }, throwOnError: true });
    let sessionId = input.sessionId;
    if (sessionId) {
      await client.session.get({ sessionID: sessionId });
    } else {
      const session = await client.session.create({ title: `WorkerDeck / ${input.profile.manifest.name}`, agent: 'relay' });
      if (!session.data) throw new Error('OpenCode did not return a session.');
      sessionId = session.data.id;
    }
    const sid = sessionId;
    input.onEvent({ kind: 'session', text: '', sessionId: sid });
    eventController = new AbortController();
    const stream = await client.event.subscribe({}, { signal: eventController.signal });
    const pending = new Set<Promise<void>>();
    let streamError: Error | undefined;
    const handle = async (event: Event) => {
      if (!('properties' in event)) return;
      const eventSession = event.type === 'message.part.updated' ? event.properties.part.sessionID
        : 'sessionID' in event.properties ? event.properties.sessionID : undefined;
      if (eventSession !== sid) return;
      if (event.type === 'message.part.delta' && event.properties.field === 'text') input.onEvent({ kind: 'text', text: event.properties.delta });
      if (event.type === 'message.part.updated') {
        const part = event.properties.part;
        if (part.type === 'tool') input.onEvent({ kind: 'activity', text: `${part.tool} · ${part.state.status}` });
      }
      if (event.type === 'permission.asked') {
        const answer = await input.ask('permission', event.properties.permission, event.properties.patterns.join('\n'), input.signal);
        await client.permission.reply({ requestID: event.properties.id, reply: answer === 'yes' ? 'once' : 'reject' });
      }
      if (event.type === 'question.asked') {
        const answers: string[][] = [];
        for (const question of event.properties.questions) {
          const answer = await input.ask('question', question.question,
            question.options.map(option => `${option.label}: ${option.description}`).join('\n'), input.signal);
          answers.push([answer]);
        }
        await client.question.reply({ requestID: event.properties.id, answers });
      }
    };
    events = (async () => {
      for await (const event of stream.stream) {
        const work = handle(event).catch(error => { streamError = error instanceof Error ? error : new Error(String(error)); }).finally(() => pending.delete(work));
        pending.add(work);
      }
    })().catch(error => { if (!eventController?.signal.aborted && !input.signal.aborted) streamError = error instanceof Error ? error : new Error(String(error)); });
    const model = modelFor(input.profile);
    const slash = model?.indexOf('/') ?? -1;
    if (model && slash < 1) throw new Error('OpenCode models must use provider/model. Set WORKERDECK_MODEL_<PROFILE_ID> or edit profile.json.');
    const abortRequest = () => { void client.session.abort({ sessionID: sid }).catch(() => {}); };
    input.signal.addEventListener('abort', abortRequest, { once: true });
    try {
      const response = await client.session.prompt({ sessionID: sid, agent: 'relay',
        ...(model ? { model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } } : {}),
        // OpenCode's forced StructuredOutput tool fails on providers supporting only tool_choice:auto.
        // The engine validates the JSON response against its schema before running any task.
        system: input.profile.manifest.instructions,
        parts: [{ type: 'text', text: input.prompt + (input.schema ? `\n\nReturn ONLY a JSON object matching this schema, without commentary or tool calls:\n${JSON.stringify(input.schema)}` : '') }] }, { signal: input.signal });
      input.signal.throwIfAborted();
      if (streamError) throw streamError;
      if (!response.data) throw new Error('No response from OpenCode.');
      if (response.data.info.error) {
        const error = response.data.info.error;
        throw new Error('data' in error && error.data && 'message' in error.data ? String(error.data.message) : JSON.stringify(error));
      }
      const text = response.data.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
      if (!text && response.data.info.structured === undefined) throw new Error('OpenCode returned no final answer.');
      return { text, sessionId: sid, structured: response.data.info.structured };
    } finally { input.signal.removeEventListener('abort', abortRequest); }
  } finally {
    input.signal.removeEventListener('abort', stop);
    eventController?.abort();
    await stopProcess(child);
    await events;
  }
}

export async function runClaude(input: RunInput): Promise<RunResult> {
  input.signal.throwIfAborted();
  const auth = await getClaudeAuth();
  if (!auth.available) throw new Error(auth.reason);
  const { root, skillPlugin } = await stageProfile(input.profile, input.stateRoot);
  input.signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal.addEventListener('abort', abort, { once: true });
  let sessionId = input.sessionId ?? '';
  let result: RunResult | undefined;
  const planner = input.role === 'orchestrator' || (!input.role && Boolean(input.schema));
  const stream = query({ prompt: input.prompt, options: {
    cwd: input.cwd,
    env: { ...process.env },
    ...(auth.executable ? { pathToClaudeCodeExecutable: auth.executable } : {}),
    abortController: controller,
    ...(input.sessionId ? { resume: input.sessionId } : {}),
    model: modelFor(input.profile),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: input.profile.manifest.instructions },
    plugins: [{ type: 'local', path: skillPlugin }, ...input.profile.manifest.plugins.map(plugin => ({ type: 'local' as const, path: safePath(root, plugin) }))],
    settingSources: ['user', 'project', 'local'],
    permissionMode: 'default',
    includePartialMessages: true,
    maxTurns: planner ? 12 : 60,
    ...(input.schema ? { outputFormat: { type: 'json_schema', schema: input.schema } as const } : {}),
    canUseTool: async (toolName, toolInput, options) => {
      if (planner) return { behavior: 'deny', message: 'Planner cannot execute tools. Return the plan.' };
      if (toolName === 'AskUserQuestion') {
        const questions = Array.isArray(toolInput.questions) ? toolInput.questions as Array<{ question: string; options?: Array<{ label: string; description: string }> }> : [];
        const answers: Record<string, string> = {};
        for (const question of questions) answers[question.question] = await input.ask('question', question.question, JSON.stringify(question.options ?? []), options.signal);
        return { behavior: 'allow', updatedInput: { ...toolInput, answers } };
      }
      const answer = await input.ask('permission', toolName, JSON.stringify(toolInput, null, 2), options.signal);
      return answer === 'yes' ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: 'The user denied this action.' };
    },
    stderr: text => input.onEvent({ kind: 'activity', text: text.slice(-1000) }),
  } });
  try {
    for await (const message of stream) {
      if ('session_id' in message && typeof message.session_id === 'string') {
        sessionId = message.session_id;
        input.onEvent({ kind: 'session', text: '', sessionId });
      }
      if (message.type === 'system' && message.subtype === 'init') {
        const expected = input.profile.manifest.skills.length ? input.profile.manifest.id : undefined;
        if (expected && !message.plugins.some(plugin => plugin.name === expected)) throw new Error(`Profile skill plugin did not load: ${expected}. Check plugin paths and SDK version.`);
        input.onEvent({ kind: 'activity', text: `Skills loaded: ${message.skills.join(', ') || '(none)'}` });
      }
      if (message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
        input.onEvent({ kind: 'text', text: message.event.delta.text });
      }
      if (message.type === 'assistant') {
        for (const block of message.message.content) if (block.type === 'tool_use') input.onEvent({ kind: 'activity', text: `${block.name} · ${JSON.stringify(block.input).slice(0, 400)}` });
      }
      if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error) {
          const detail = message.subtype === 'success' ? message.result : message.errors.join('\n');
          throw new Error(detail || `Claude stopped: ${message.subtype}`);
        }
        result = { text: message.result, sessionId, structured: message.structured_output };
      }
    }
    input.signal.throwIfAborted();
    if (!result || (!result.text && result.structured === undefined)) throw new Error('Claude returned no successful final answer.');
    return result;
  } catch (error) {
    if (error instanceof Error && /OAuth|authenticate|authentication/i.test(error.message) && auth.method === 'native-login') {
      throw new Error(`Claude login failed. Run \`claude auth login\`, then /retry. ${error.message}`);
    }
    throw error;
  } finally {
    input.signal.removeEventListener('abort', abort);
    stream.close();
  }
}

export async function nativeRuntime(harness: LoadedProfile['manifest']['harness']) {
  const executable = harness === 'opencode' ? await findOpenCode() : harness === 'codex' ? await findCodex() : await findClaude();
  if (!executable) throw new Error('Install the native Claude CLI to build/run locked Claude images.');
  const { stdout } = await promisify(execFile)(executable, ['--version'], { windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024 });
  const version = stdout.trim().match(/^(?:codex-cli )?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)/)?.[1];
  if (!version) throw new Error('Could not identify the native harness version.');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const adapter = harness === 'opencode' ? '@opencode-ai/sdk' : '@anthropic-ai/claude-agent-sdk';
  return { version, adapterVersion: String(harness === 'codex' ? pkg.version : pkg.dependencies[adapter]), platform: process.platform, arch: process.arch };
}

export async function checkImageRuntime(profile: LoadedProfile): Promise<void> {
  if (!profile.image) return;
  const image = profile.image;
  if (image.platform !== process.platform || image.arch !== process.arch) throw new Error(`Image requires ${image.platform}/${image.arch}; current machine is ${process.platform}/${process.arch}. Build an image for this platform.`);
  if (modelFor(profile) !== profile.manifest.model) throw new Error(`Model override changes locked image @${profile.manifest.id}. Fork and rebuild the image instead.`);
  const actual = await nativeRuntime(profile.manifest.harness);
  if (actual.version !== image.runtimeVersion || actual.adapterVersion !== image.adapterVersion) {
    throw new Error(`Image requires ${profile.manifest.harness} ${image.runtimeVersion} / adapter ${image.adapterVersion}; installed ${actual.version} / ${actual.adapterVersion}. Install the required version or rebuild.`);
  }
}

export const runNative: Runner = async input => {
  await checkImageRuntime(input.profile);
  return input.profile.manifest.harness === 'opencode' ? runOpenCode(input) : input.profile.manifest.harness === 'codex' ? runCodex(input, modelFor(input.profile)) : runClaude(input);
};

export function missingEnv(profile: LoadedProfile): string[] {
  return profile.manifest.requiredEnv.filter(key => !process.env[key] &&
    !(key === 'ANTHROPIC_API_KEY' && profile.manifest.harness === 'claude' && claudeCloudConfigured()));
}

export async function inspectProfiles(profiles: LoadedProfile[]): Promise<Availability> {
  const codex = profiles.some(profile => profile.manifest.harness === 'codex') ? await getCodexAuth() : undefined;
  const claude = profiles.some(profile => profile.manifest.harness === 'claude') ? await getClaudeAuth().catch(error => ({
    available: false, reason: error instanceof Error ? error.message : String(error),
  })) : undefined;
  let openCode: { available: boolean; reason: string } | undefined;
  if (profiles.some(profile => profile.manifest.harness === 'opencode')) {
    try { await findOpenCode(); openCode = { available: true, reason: 'Native OpenCode installed; provider authentication is managed by OpenCode.' }; }
    catch (error) { openCode = { available: false, reason: error instanceof Error ? error.message : String(error) }; }
  }
  const readiness: Availability = Object.fromEntries(profiles.map(profile => {
    const missing = missingEnv(profile);
    const native = profile.manifest.harness === 'claude' ? claude! : profile.manifest.harness === 'codex' ? codex! : openCode!;
    const checks: ReadinessCheck[] = [];
    if (profile.manifest.harness === 'codex' && profile.manifest.plugins.length) checks.push({ kind: 'plugins', status: 'blocked',
      reason: 'Packaged Codex plugins are not supported yet.', action: 'Configure plugins natively or use a profile without bundled plugins.' });
    checks.push({ kind: 'environment', status: missing.length ? 'blocked' : 'passed',
      reason: missing.length ? `Missing: ${missing.join(', ')}` : 'All declared environment variables are set.',
      ...(missing.length ? { action: 'Set the named variables in the environment that launches WorkerDeck. Keep values out of profile bundles.' } : {}) });
    checks.push({ kind: 'native', status: native.available ? 'passed' : 'blocked', reason: native.reason,
      ...(!native.available ? { action: profile.manifest.harness === 'opencode'
        ? 'Install native OpenCode or fix WORKERDECK_OPENCODE_BIN, then configure its provider with `opencode`.'
        : profile.manifest.harness === 'codex' ? 'Install native Codex or fix WORKERDECK_CODEX_BIN, then run `codex login`.'
          : 'Run `claude auth login` or configure an API key/cloud provider in the local environment.' } : {}) });
    const blocked = checks.find(check => check.status === 'blocked');
    return [profile.manifest.id, { available: !blocked, reason: blocked ? [blocked.reason, blocked.action].filter(Boolean).join(' ') : native.reason, checks }];
  }));
  for (const profile of profiles) {
    const result = readiness[profile.manifest.id]!;
    if (profile.image) {
      try { await checkImageRuntime(profile); result.checks!.push({ kind: 'image', status: 'passed', reason: 'Locked model, platform and native runtime versions match.' }); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result.checks!.push({ kind: 'image', status: 'blocked', reason, action: 'Restore the locked model/runtime/platform or rebuild the image for this machine.' });
        if (result.available) result.reason = reason;
        result.available = false;
      }
    }
    result.checks!.push({ kind: 'provider', status: 'unverified', reason: 'Model access and native skill/plugin loading are checked only when a session runs.',
      action: 'Authenticate/configure the native harness locally, then run a session to verify provider access.' });
  }
  return readiness;
}

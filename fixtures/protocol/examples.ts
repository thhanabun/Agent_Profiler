import { protocolMethods } from '../../src/contracts.js';
import type { ProfileChoiceSummary, ProfileReadiness, ProtocolEvent, ProtocolRequest, ProtocolResponse, View } from '../../src/contracts.js';

// Synthetic, browser-safe data. No model calls, credentials or real project paths.
export const fixtureMode = 'simulation' as const;
const time = '2026-10-16T00:00:00.000Z';
const sessionId = '10000000-0000-4000-8000-000000000001';
const plannerRunId = '20000000-0000-4000-8000-000000000001';
const workerRunId = '20000000-0000-4000-8000-000000000002';
const requestId = '30000000-0000-4000-8000-000000000001';

export const fixtureChoices: ProfileChoiceSummary[] = ['orchestrator', 'codex'].map((id, index) => ({
  schemaVersion: 1, id, reference: id, name: index ? 'Fixture Codex worker' : 'Fixture planner', version: '1.0.0',
  description: 'Synthetic profile for interface development.', role: index ? 'worker' : 'orchestrator',
  harness: index ? 'codex' : 'opencode', model: index ? 'fixture-codex-model' : 'fixture/planner-model',
  capabilities: [index ? 'implementation' : 'planning'], instructions: 'SIMULATION ONLY',
  skills: [], plugins: [], requiredEnv: [], source: `/example/profiles/${id}`, checksum: (index ? 'b' : 'a').repeat(64),
}));

export const fixtureReadiness: Record<'ready' | 'blocked', ProfileReadiness> = {
  ready: { reference: 'codex', profileId: 'codex', harness: 'codex', model: 'fixture-codex-model',
    checksum: 'b'.repeat(64), checkedAt: time, available: true, reason: 'SIMULATION: local setup passed.',
    checks: [
      { kind: 'source', status: 'passed', reason: 'SIMULATION: manifest and declared files are valid.' },
      { kind: 'native', status: 'passed', reason: 'SIMULATION: native login found.' },
      { kind: 'provider', status: 'unverified', reason: 'No model request was made.' },
    ] },
  blocked: { reference: 'codex', profileId: 'codex', harness: 'codex', checkedAt: time, available: false,
    reason: 'SIMULATION: native login missing.', checks: [{ kind: 'native', status: 'blocked',
      reason: 'SIMULATION: native login missing.', action: 'Run `codex login` in your terminal, then check again.' }] },
};

const task = { id: 'add-greeting', title: 'Add a greeting', goal: 'Create a small greeting function.', profileId: 'codex',
  reason: 'Implementation profile selected by the planner.', dependsOn: [], acceptance: ['The function returns a greeting.'], status: 'pending' as const };
const plannerRun = { id: plannerRunId, profileId: 'orchestrator', role: 'orchestrator' as const, harness: 'opencode' as const,
  model: 'fixture/planner-model', status: 'completed' as const, startedAt: time, endedAt: time, nativeSessionId: 'fixture-native-planner' };
const workerRun = { id: workerRunId, profileId: 'codex', role: 'worker' as const, harness: 'codex' as const,
  model: 'fixture-codex-model', taskId: task.id, status: 'running' as const, startedAt: time, nativeSessionId: 'fixture-native-worker' };
const idle: View = {
  busy: false, phase: 'SIMULATION: ready', paused: false, output: '', status: 'idle', availability: {},
  session: { version: 1, id: sessionId, cwd: '/example/project', demo: true, title: 'SIMULATION: greeting task',
    createdAt: time, updatedAt: time, goal: '', planCount: 0, summary: '', needsPlan: false, steering: [], tasks: [], messages: [], runs: [], nativeSessions: {}, diffs: {},
    configuration: { orchestratorProfileId: 'orchestrator', workerProfileIds: ['codex'], profiles: fixtureChoices.map(profile => ({
      id: profile.id, harness: profile.harness, model: profile.model, source: { kind: 'local', path: profile.source, checksum: profile.checksum },
    })) } },
};
const planning: View = { ...structuredClone(idle), busy: true, status: 'planning', phase: 'SIMULATION: choosing a worker', activeRunId: plannerRunId,
  availability: Object.fromEntries(fixtureChoices.map(profile => [profile.id, { available: true, reason: 'SIMULATION: setup passed.' }])),
  session: { ...structuredClone(idle.session), goal: 'Add a greeting function.', runs: [{ ...plannerRun, status: 'running', endedAt: undefined }],
    messages: [{ id: 'fixture-user', role: 'user', text: 'Add a greeting function.', time }] } };
const running: View = { ...structuredClone(planning), status: 'running', phase: 'SIMULATION: Codex is implementing', activeTask: task.id,
  activeRunId: workerRunId, output: 'SIMULATION: preparing the greeting function.',
  session: { ...structuredClone(planning.session), planCount: 1, summary: 'Add a greeting function using Codex.',
    tasks: [{ ...task, status: 'running' }], runs: [plannerRun, workerRun] } };

// Each named state is an independent screen fixture, not a replay of one execution.
export const fixtureStates: Record<string, View> = {
  idle, planning, running,
  trust: { ...structuredClone(planning), status: 'waiting', request: { id: requestId, kind: 'trust', title: 'SIMULATION: trust this profile?', detail: 'Synthetic source and checksum; no code will run.' } },
  permission: { ...structuredClone(running), status: 'waiting', request: { id: requestId, kind: 'permission', title: 'SIMULATION: allow file edit?', detail: 'Example change to greeting.ts. No real file is modified.' } },
  question: { ...structuredClone(running), status: 'waiting', request: { id: requestId, kind: 'question', title: 'SIMULATION: choose greeting language', detail: 'English or Thai?' } },
  paused: { ...structuredClone(idle), status: 'paused', paused: true, phase: 'SIMULATION: paused',
    session: { ...structuredClone(running.session), tasks: [task], runs: [plannerRun] } },
  stopping: { ...structuredClone(running), status: 'stopping', phase: 'SIMULATION: stopping' },
  stopped: { ...structuredClone(idle), status: 'stopped', phase: 'SIMULATION: stopped', session: { ...structuredClone(running.session),
    tasks: [{ ...task, status: 'stopped' }], runs: [plannerRun, { ...workerRun, status: 'stopped', endedAt: time }] } },
  failed: { ...structuredClone(idle), status: 'error', phase: 'SIMULATION: needs attention', error: 'SIMULATION: provider unavailable; retry after checking native login.',
    session: { ...structuredClone(running.session), tasks: [{ ...task, status: 'failed', error: 'SIMULATION: provider unavailable.' }],
      runs: [plannerRun, { ...workerRun, status: 'failed', endedAt: time, error: 'SIMULATION: provider unavailable.' }] } },
  completed: { ...structuredClone(idle), phase: 'SIMULATION: completed', session: { ...structuredClone(running.session),
    tasks: [{ ...task, status: 'completed', result: 'SIMULATION: example greeting function delivered.', changedFiles: ['greeting.ts'] }],
    runs: [plannerRun, { ...workerRun, status: 'completed', endedAt: time }],
    diffs: { [task.id]: "SIMULATION: synthetic diff; no real files changed.\n--- /dev/null\n+++ b/greeting.ts\n@@ -0,0 +1 @@\n+export const greet = (name: string) => `Hello, ${name}!`;\n" },
    messages: [...planning.session.messages, { id: 'fixture-worker', role: 'worker', profileId: 'codex', taskId: task.id, text: 'SIMULATION: greeting function delivered.', time }] } },
};

export const fixtureRequests: ProtocolRequest[] = [
  { version: 1, id: 'choices', method: 'profiles.choices', params: {} },
  { version: 1, id: 'readiness', method: 'profiles.readiness', params: { reference: 'codex' } },
  { version: 1, id: 'create', method: 'session.create', params: { title: 'SIMULATION: greeting task', orchestrator: 'orchestrator', workers: ['codex'] } },
  { version: 1, id: 'submit', method: 'session.submit', params: { sessionId, text: 'Add a greeting function.' } },
  { version: 1, id: 'answer', method: 'request.respond', params: { sessionId, requestId, answer: 'no' } },
  { version: 1, id: 'stop', method: 'session.stop', params: { sessionId } },
  { version: 1, id: 'stale-answer', method: 'request.respond', params: { sessionId, requestId, answer: 'yes' } },
];
export const fixtureResponses: ProtocolResponse[] = [
  { version: 1, id: 'choices', ok: true, result: fixtureChoices },
  { version: 1, id: 'readiness', ok: true, result: fixtureReadiness.ready },
  { version: 1, id: 'create', ok: true, result: fixtureStates.idle! },
  { version: 1, id: 'submit', ok: true, result: { accepted: true } },
  { version: 1, id: 'answer', ok: true, result: null },
  { version: 1, id: 'stop', ok: true, result: null },
  { version: 1, id: 'stale-answer', ok: false, error: 'This request is no longer active. Refresh the session before replying.' },
];
export const fixtureEvents: ProtocolEvent[] = [
  { version: 1, event: 'ready', methods: [...protocolMethods] },
  ...Object.values(fixtureStates).map((state, index) => ({ version: 1 as const, event: 'session.state' as const, sequence: index + 1, sessionId, state })),
  { version: 1, event: 'operation.error', sessionId, error: 'SIMULATION: operation failed outside a native run.' },
];

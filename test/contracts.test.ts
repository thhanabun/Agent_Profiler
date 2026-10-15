import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRequest, protocolMethods } from '../src/contracts.js';
import { sessionSchema } from '../src/engine.js';
import { profileSchema } from '../src/schema.js';
import { fixtureChoices, fixtureEvents, fixtureMode, fixtureReadiness, fixtureRequests, fixtureResponses, fixtureStates } from '../fixtures/protocol/examples.js';

test('shared request parser rejects method-specific invalid input and accepts empty params for list methods', () => {
  assert.deepEqual(parseRequest({ version: 1, id: 'choices', method: 'profiles.choices', params: {} }).params, {});
  assert.throws(() => parseRequest({ version: 1, id: 'readiness', method: 'profiles.readiness', params: {} }));
  assert.throws(() => parseRequest({ version: 1, id: 'readiness', method: 'profiles.readiness', params: { reference: 'codex', token: 'unexpected' } }));
  assert.throws(() => parseRequest({ version: 2, id: 'get', method: 'session.get', params: {} }));
  assert.throws(() => parseRequest({ version: 1, id: 'get', method: 'session.get', params: { sessionId: 'not-a-uuid' } }));
});

test('UI fixtures remain compatible with session schemas, references and the published JSONL contract', () => {
  assert.equal(fixtureMode, 'simulation');
  for (const request of fixtureRequests) assert.deepEqual(parseRequest(request), request);
  for (const choice of fixtureChoices) {
    const { reference, source, checksum, image, ...manifest } = choice;
    assert.equal(profileSchema.parse(manifest).id, reference); assert(source); assert.match(checksum, /^[a-f0-9]{64}$/);
  }
  for (const [name, state] of Object.entries(fixtureStates)) {
    sessionSchema.parse(state.session); assert.equal(state.session.demo, true, name);
    if (state.activeRunId) assert(state.session.runs.some(run => run.id === state.activeRunId), name);
    if (state.activeTask) assert(state.session.tasks.some(task => task.id === state.activeTask), name);
    if (state.request) { assert.equal(state.status, 'waiting', name); assert(state.busy, name); }
    if (!state.busy) assert(state.session.runs.every(run => run.status !== 'running'), name);
    for (const task of state.session.tasks) assert(state.session.configuration!.workerProfileIds.includes(task.profileId), name);
  }
  assert.deepEqual(new Set(Object.values(fixtureStates).map(state => state.status)), new Set(['idle', 'planning', 'running', 'waiting', 'paused', 'stopping', 'stopped', 'error']));
  assert.deepEqual(new Set(Object.values(fixtureStates).flatMap(state => state.request ? [state.request.kind] : [])), new Set(['trust', 'permission', 'question']));
  for (const response of fixtureResponses) assert(fixtureRequests.some(request => request.id === response.id));
  assert.equal(fixtureReadiness.ready.available, true); assert.equal(fixtureReadiness.blocked.available, false);
  assert(fixtureReadiness.blocked.checks.some(check => check.status === 'blocked' && check.action));
  const ready = fixtureEvents.find(event => event.event === 'ready')!;
  assert.deepEqual(ready.methods, protocolMethods);
  for (const event of fixtureEvents) if (event.event === 'session.state') assert.equal(event.sessionId, event.state.session.id);
});

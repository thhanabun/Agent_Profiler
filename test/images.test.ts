import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { blobPath, buildImage, copyImage, diffImages, forkImage, imageReference, jsonBytes, listImages, loadImage, parseManifest } from '../src/images.js';
import { builtinRoot, createProfile, loadProfile } from '../src/profiles.js';
import { exportCatalog, remoteReference, searchCatalog } from '../src/registry.js';
import { loadTeam, lockTeam, pullTeam } from '../src/teams.js';
import { checkImageRuntime } from '../src/adapters.js';
import { Engine, readSession } from '../src/engine.js';
import { encodeBundle } from '../src/bundles.js';
import { SessionManager } from '../src/application.js';

const runtime = { version: '1.19.0', adapterVersion: '1.19.0', platform: 'win32' as const, arch: 'x64' as const };

test('bundle bytes are independent of input ordering and local timezone', () => {
  const saved = process.env.TZ;
  try {
    const files = { 'profile.json': Buffer.from('{}'), 'skills/z.txt': Buffer.from('z'), 'skills/a.txt': Buffer.from('a') };
    process.env.TZ = 'UTC'; const a = encodeBundle(files);
    process.env.TZ = 'America/Los_Angeles'; const b = encodeBundle(Object.fromEntries(Object.entries(files).reverse()));
    process.env.TZ = 'Asia/Bangkok'; const c = encodeBundle(files);
    assert.deepEqual(a, b); assert.deepEqual(a, c);
  } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
});
async function fixture(work: (root: string, store: string, source: string) => Promise<void>) {
  const parent = path.resolve('.workerdeck/tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'images-'));
  const source = path.join(root, 'source');
  try { await createProfile(source, 'fixture-builder', 'opencode'); await work(root, path.join(root, 'store with spaces'), source); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('images build deterministically, require a model, preserve immutable tags and exclude runtime state', () => fixture(async (_root, store, source) => {
  const profile = await loadProfile(source);
  await assert.rejects(buildImage(store, profile, 'alice/builder:1.0', { runtime }), /explicit model/);
  await writeFile(path.join(source, '.env'), 'PRIVATE=do-not-package');
  await mkdir(path.join(source, 'sessions')); await writeFile(path.join(source, 'sessions', 'private.json'), 'private');
  const a = await buildImage(store, profile, 'alice/builder:1.0', { runtime, model: 'provider/model' });
  const b = await buildImage(store, profile, 'alice/builder:1.0', { runtime, model: 'provider/model' });
  assert.equal(a.digest, b.digest);
  assert.equal(a.profile.manifest.model, 'provider/model');
  assert.equal((await listImages(store)).length, 1);
  await assert.rejects(readFile(path.join(a.profile.root, '.env')), /ENOENT/);
  await assert.rejects(buildImage(store, profile, 'alice/builder:1.0', { runtime, model: 'provider/other' }), /already identifies/);
  const other = await buildImage(store, profile, 'alice/builder:2.0', { runtime, model: 'provider/other' });
  assert.notEqual(other.digest, a.digest);
  assert.deepEqual((await diffImages(store, a.digest, other.digest)).model, ['provider/model', 'provider/other']);
}));

test('forked images retain their base digest, support source customization, and reject a changed harness', () => fixture(async (root, store, source) => {
  const base = await buildImage(store, await loadProfile(source), 'alice/builder:1', { runtime, model: 'provider/model' });
  const fork = path.join(root, 'my brand'); await forkImage(store, base.digest, fork, 'brand-builder');
  await writeFile(path.join(fork, 'skills/working-notes/SKILL.md'), '---\nname: working-notes\ndescription: Brand handoff\n---\nUse our brand voice.');
  const derived = await buildImage(store, await loadProfile(fork), 'bob/builder:1', { runtime });
  assert.equal(derived.metadata.parent, base.digest);
  assert.match(await readFile(path.join(derived.profile.root, 'skills/working-notes/SKILL.md'), 'utf8'), /brand voice/);
  assert((await diffImages(store, base.digest, derived.digest)).files.includes('skills/working-notes/SKILL.md'));
  const manifest = JSON.parse(await readFile(path.join(fork, 'profile.json'), 'utf8')); manifest.harness = 'claude';
  await writeFile(path.join(fork, 'profile.json'), JSON.stringify(manifest));
  await assert.rejects(buildImage(store, await loadProfile(fork), 'bob/invalid:1', { runtime }), /same harness/);
}));

test('image copy to a clean store validates blobs and detects source/cache corruption', () => fixture(async (root, store, source) => {
  const built = await buildImage(store, await loadProfile(source), 'alice/builder:1', { runtime, model: 'provider/model' });
  const destination = path.join(root, 'another-machine');
  const pulled = await copyImage(store, destination, built.digest, 'alice/builder:1');
  assert.equal(pulled.digest, built.digest);
  await writeFile(path.join(pulled.profile.root, 'skills/working-notes/SKILL.md'), 'tampered');
  await assert.rejects(loadImage(destination, built.digest), /modified/);
  const file = blobPath(store, built.manifest.layers[0]!.digest);
  const bytes = await readFile(file); bytes[0] = bytes[0]! ^ 1; await writeFile(file, bytes);
  await assert.rejects(loadImage(store, built.digest), /checksum mismatch/);
}));

test('image reference and manifest validation reject unsafe or oversized inputs', () => fixture(async (_root, store, source) => {
  for (const ref of ['../x:1', 'name', 'owner/name', 'owner/name:--evil/../x', 'https://example.com/x:1', 'sha256:../../bad']) assert.throws(() => imageReference(ref));
  assert.equal(remoteReference('alice/ui:1'), 'registry-1.docker.io/alice/ui:1');
  assert.equal(remoteReference('localhost:5000/alice/ui:1'), 'localhost:5000/alice/ui:1');
  const image = await buildImage(store, await loadProfile(source), 'alice/builder:1', { runtime, model: 'provider/model' });
  assert.throws(() => parseManifest(jsonBytes({ ...image.manifest, layers: [...image.manifest.layers, image.manifest.layers[0]] })));
  assert.throws(() => parseManifest(jsonBytes({ ...image.manifest, config: { ...image.manifest.config, size: 1024 * 1024 + 1 } })), /sizes/);
  assert.throws(() => parseManifest(jsonBytes({ ...image.manifest, artifactType: 'unknown' })));
}));

test('catalog search shares image metadata without executing source', () => fixture(async (root, store, source) => {
  await buildImage(store, await loadProfile(source), 'alice/builder:1', { runtime, model: 'provider/model' });
  const catalog = path.join(root, 'catalog.json'); await exportCatalog(store, catalog);
  assert.equal((await searchCatalog(store, 'opencode', catalog)).length, 1);
  assert.equal((await searchCatalog(store, 'not-found', catalog)).length, 0);
  await assert.rejects(exportCatalog(store, catalog), /already exists/);
  await assert.rejects(searchCatalog(store, '', 'http://example.com/catalog.json'), /HTTPS/);
}));

test('team locks freeze each image digest and reject changed manifests or colliding IDs', () => fixture(async (root, store, source) => {
  const worker = await buildImage(store, await loadProfile(source), 'alice/builder:1', { runtime, model: 'provider/model' });
  const conductorDir = path.join(root, 'conductor'); await createProfile(conductorDir, 'fixture-conductor', 'opencode');
  const manifest = JSON.parse(await readFile(path.join(conductorDir, 'profile.json'), 'utf8')); manifest.role = 'orchestrator';
  await writeFile(path.join(conductorDir, 'profile.json'), JSON.stringify(manifest));
  await buildImage(store, await loadProfile(conductorDir), 'alice/conductor:1', { runtime, model: 'provider/model' });
  const file = path.join(root, 'team.json');
  const team = { schemaVersion: 1, name: 'My team', orchestrator: 'alice/conductor:1', workers: ['alice/builder:1'] };
  await writeFile(file, JSON.stringify(team)); const lock = await lockTeam(store, file);
  assert.equal(lock.images[1]!.digest, worker.digest);
  const loaded = await loadTeam(store, file);
  assert.deepEqual(loaded.profiles.map(profile => profile.manifest.id), ['fixture-conductor', 'fixture-builder']);
  assert.equal((await pullTeam(store, file)).profiles.length, 2);
  // Team position assigns roles even when the image's old role hint differs.
  const swapped = { ...team, orchestrator: 'alice/builder:1', workers: ['alice/conductor:1'] };
  await writeFile(file, JSON.stringify(swapped)); await lockTeam(store, file);
  const assigned = await loadTeam(store, file);
  const manager = new SessionManager({ cwd: root, stateRoot: path.join(root, 'state'), store, extraRoot: path.join(root, 'profiles'), demo: true });
  const session = await manager.createTeam(assigned.profiles);
  assert.equal(session.orchestratorProfileId, 'fixture-builder');
  const reopened = await manager.open(session.state.session.id);
  assert.equal(reopened.orchestratorProfileId, 'fixture-builder');
  assert.deepEqual(reopened.workerProfileIds, ['fixture-conductor']);
  assert.equal(reopened.state.session.configuration!.profiles[0]!.source.kind, 'image');
  await writeFile(file, JSON.stringify({ ...team, name: 'Changed' }));
  await assert.rejects(loadTeam(store, file), /manifest changed/);
  await writeFile(file, JSON.stringify({ ...team, workers: ['alice/builder:1', 'alice/builder:1'] }));
  await assert.rejects(lockTeam(store, file), /collide/);
}));

test('image builds reject changed sources and external package dependency declarations', () => fixture(async (_root, store, source) => {
  const stale = await loadProfile(source);
  await writeFile(path.join(source, 'skills/working-notes/package.json'), '{"dependencies":{"unlocked-library":"*"}}');
  await assert.rejects(buildImage(store, stale, 'alice/builder:1', { runtime, model: 'provider/model' }), /source changed/);
  await assert.rejects(buildImage(store, await loadProfile(source), 'alice/builder:1', { runtime, model: 'provider/model' }), /External dependencies/);
}));

test('locked images reject model environment overrides before launching the native runtime', () => fixture(async (_root, store, source) => {
  const built = await buildImage(store, await loadProfile(source), 'alice/builder:1', { runtime, model: 'provider/model' });
  const key = 'WORKERDECK_MODEL_FIXTURE_BUILDER', previous = process.env[key];
  try {
    process.env[key] = 'provider/changed';
    const profile = { ...built.profile, image: { ...built.profile.image!, platform: process.platform, arch: process.arch } };
    await assert.rejects(checkImageRuntime(profile), /Model override/);
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
}));

test('Codex images preserve prerelease runtime versions and appear in shared catalogs', () => fixture(async (root, store) => {
  const built = await buildImage(store, await loadProfile(path.join(builtinRoot, 'codex')), 'alice/codex:1', {
    runtime: { ...runtime, version: '0.162.0-alpha.17.2', adapterVersion: '0.1.0' }, model: 'fixture-codex-model',
  });
  assert.equal(built.metadata.profile.harness, 'codex');
  assert.equal(built.profile.image!.runtimeVersion, '0.162.0-alpha.17.2');
  assert.equal((await loadImage(store, built.digest)).profile.manifest.skills[0], 'skills/handoff');
  const file = path.join(root, 'catalog.json'); await exportCatalog(store, file);
  assert.equal((await searchCatalog(store, 'codex', file))[0]!.harness, 'codex');
  const manager = new SessionManager({ cwd: root, stateRoot: path.join(root, 'state'), store, extraRoot: path.join(root, 'profiles'), demo: true });
  const choices = await manager.choices();
  assert(choices.some(choice => choice.reference === 'codex' && !choice.profile.image));
  assert(choices.some(choice => choice.reference === 'alice/codex:1' && choice.profile.image?.digest === built.digest));
}));

test('direct image chat bypasses planning, resumes native sessions and locks the selected image identity', () => fixture(async (root, store, source) => {
  const built = await buildImage(store, await loadProfile(source), 'alice/builder:1', { runtime, model: 'provider/model' });
  const stateRoot = path.join(root, 'state'); const calls: Array<string | undefined> = [];
  const engine = new Engine({ cwd: root, stateRoot, profiles: [built.profile], directProfileId: built.profile.manifest.id, demo: true,
    runner: async input => { assert.equal(input.schema, undefined); calls.push(input.sessionId); return { text: 'Native response', sessionId: 'native-direct' }; } });
  await engine.submit('Hello'); await engine.submit('Follow up');
  assert.deepEqual(calls, [undefined, 'native-direct']);
  assert.equal(engine.state.error, undefined);
  const session = await readSession(stateRoot, engine.state.session.id, root, true);
  assert.equal(session.selection!.images['fixture-builder'], built.digest);
  assert.throws(() => new Engine({ cwd: root, stateRoot, profiles: [built.profile], session, demo: true }), /same image\/team/);
  const unavailable = { ...built.profile, image: { ...built.profile.image!, platform: 'not-this-platform' } };
  await assert.rejects(checkImageRuntime(unavailable), /requires/);
}));

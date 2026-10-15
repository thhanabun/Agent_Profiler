// Run explicitly with a loopback registry; the normal offline suite never invokes this file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildImage, loadImage } from '../src/images.js';
import { createProfile, loadProfile } from '../src/profiles.js';
import { pullImage, pushImage } from '../src/registry.js';
import { loadTeam, lockTeam, pullTeam } from '../src/teams.js';

test('real OCI registry: push/pull, immutable version guard, and locked team download', async () => {
  const registry = process.env.SUBHARNESS_TEST_REGISTRY ?? '';
  assert.match(registry, /^(localhost|127\.0\.0\.1):\d+$/, 'Set SUBHARNESS_TEST_REGISTRY to your loopback registry host:port.');
  const parent = path.resolve('.subharness/tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'registry-'));
  try {
    const publisher = path.join(root, 'publisher'), recipient = path.join(root, 'recipient');
    const source = path.join(root, 'source'); await createProfile(source, 'registry-builder', 'opencode');
    const runtime = { version: '1.19.0', adapterVersion: '1.19.0', platform: 'win32' as const, arch: 'x64' as const };
    const worker = await buildImage(publisher, await loadProfile(source), 'test/builder:1', { runtime, model: 'fixture/model' });
    const namespace = `${registry}/test/${randomUUID()}`;
    const workerRef = `${namespace}/builder:1`, conductorRef = `${namespace}/conductor:1`;
    const options = { plainHttp: true };
    await pushImage(publisher, 'test/builder:1', workerRef, options);
    assert.equal((await pullImage(recipient, workerRef, options)).digest, worker.digest);
    await buildImage(publisher, await loadProfile(source), 'test/builder:2', { runtime, model: 'fixture/different' });
    await assert.rejects(pushImage(publisher, 'test/builder:2', workerRef, options), /different content/);
    assert.equal((await pullImage(recipient, workerRef, options)).digest, worker.digest);
    const file = path.join(source, 'profile.json');
    const manifest = JSON.parse(await readFile(file, 'utf8')); manifest.id = 'registry-conductor'; manifest.role = 'orchestrator';
    await writeFile(file, JSON.stringify(manifest));
    await buildImage(publisher, await loadProfile(source), 'test/conductor:1', { runtime, model: 'fixture/model' });
    await pushImage(publisher, 'test/conductor:1', conductorRef, options);
    const teamFile = path.join(root, 'team.json');
    await writeFile(teamFile, JSON.stringify({ schemaVersion: 1, name: 'Registry test', orchestrator: conductorRef, workers: [workerRef] }));
    await lockTeam(publisher, teamFile);
    const clean = path.join(root, 'clean-team-store');
    await pullTeam(clean, teamFile, options);
    const team = await loadTeam(clean, teamFile);
    assert.equal(team.profiles.length, 2);
    assert.equal(team.profiles[1]!.image!.digest, worker.digest);
    assert.equal((await loadImage(clean, worker.digest)).profile.manifest.model, 'fixture/model');
  } finally {
    const relative = path.relative(parent, path.resolve(root));
    assert(!relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  }
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DIGEST, imageReference, jsonBytes, loadImage } from './images.js';
import { digest } from './profiles.js';
import { writeJsonAtomic } from './storage.js';
import { pullImage, type RegistryOptions } from './registry.js';

const reference = z.string().max(400).refine(value => { try { imageReference(value); return true; } catch { return false; } });
const teamSchema = z.object({ schemaVersion: z.literal(1), name: z.string().min(1).max(80), orchestrator: reference, workers: z.array(reference).min(1).max(16) }).strict();
const lockSchema = z.object({ schemaVersion: z.literal(1), sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  images: z.array(z.object({ reference, digest: DIGEST }).strict()).min(2).max(17) }).strict();

function lockPath(file: string) { return path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.lock.json`); }
async function readTeam(file: string) { return teamSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }

export async function lockTeam(store: string, file: string) {
  const team = await readTeam(file);
  const images = [];
  for (const reference of [team.orchestrator, ...team.workers]) images.push({ reference, digest: (await loadImage(store, reference)).digest });
  await validateMembers(store, images.map(item => item.digest));
  const lock = { schemaVersion: 1 as const, sourceChecksum: digest(jsonBytes(team)), images };
  await writeJsonAtomic(lockPath(file), lock);
  return lock;
}

async function validateMembers(store: string, references: string[]) {
  const profiles = [];
  for (const reference of references) profiles.push((await loadImage(store, reference)).profile);
  // Roles belong to this team: the first profile is the orchestrator, regardless of its legacy role hint.
  if (new Set(profiles.map(profile => profile.manifest.id)).size !== profiles.length) throw new Error('Team profile IDs collide. Fork images with unique IDs.');
  return profiles;
}

async function readLockedTeam(file: string) {
  const team = await readTeam(file);
  const lock = lockSchema.parse(JSON.parse(await readFile(lockPath(file), 'utf8')));
  if (lock.sourceChecksum !== digest(jsonBytes(team)) || JSON.stringify(lock.images.map(item => item.reference)) !== JSON.stringify([team.orchestrator, ...team.workers])) throw new Error('Team manifest changed. Run team lock again after reviewing the images.');
  return { team, lock };
}

export async function loadTeam(store: string, file: string) {
  const { team, lock } = await readLockedTeam(file);
  const profiles = await validateMembers(store, lock.images.map(item => item.digest));
  return { team, lock, profiles };
}

export async function pullTeam(store: string, file: string, options: RegistryOptions = {}) {
  const { lock } = await readLockedTeam(file);
  for (const item of lock.images) {
    try { await loadImage(store, item.digest); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const { repository } = imageReference(item.reference);
    if (!repository) throw new Error('Team downloads require repository names in team.json, not bare digests.');
    await pullImage(store, `${repository}@${item.digest}`, options);
  }
  return loadTeam(store, file);
}

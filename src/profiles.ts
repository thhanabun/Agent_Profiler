import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileSchema, type LoadedProfile, type Profile } from './schema.js';

export const builtinRoot = fileURLToPath(new URL('../profiles/', import.meta.url));
export const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const sensitive = /(^|\/)(?:\.env(?:\..*)?|auth\.json|\.?credentials(?:\..*)?|sessions?|memory(?:\.json)?|node_modules|\.git|\.subharness|.*\.(?:pem|key))($|\/)/i;

export function safePath(root: string, name: string): string {
  if (!name || name.includes('\\') || name.includes(':') || /[\x00-\x1f\x7f<>"|?*]/.test(name) || name.startsWith('/') ||
      name.split('/').some(part => !part || part === '.' || part === '..') || sensitive.test(name)) {
    throw new Error(`Unsafe or private bundle path: ${name}`);
  }
  const target = path.resolve(root, ...name.split('/'));
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path escapes profile: ${name}`);
  return target;
}

export async function sourceFiles(root: string): Promise<Record<string, Uint8Array>> {
  const manifest = profileSchema.parse(JSON.parse(await readFile(path.join(root, 'profile.json'), 'utf8')));
  const files: Record<string, Uint8Array> = Object.create(null);
  const rootReal = await realpath(root);
  let total = 0;
  const collect = async (name: string): Promise<void> => {
    const target = safePath(root, name);
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${name}`);
    const canonical = await realpath(target);
    const relative = path.relative(rootReal, canonical);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path escapes profile: ${name}`);
    if (stat.isDirectory()) {
      for (const entry of await readdir(target)) await collect(`${name}/${entry}`);
    } else if (stat.isFile()) {
      if (files[name]) return;
      total += stat.size;
      if (total > 50 * 1024 * 1024 || Object.keys(files).length >= 1000) throw new Error('Profile exceeds 50 MiB or 1,000 files.');
      files[name] = new Uint8Array(await readFile(target));
    } else throw new Error(`Not a regular file: ${name}`);
  };
  await collect('profile.json');
  if (manifest.readme) await collect(manifest.readme);
  for (const skill of manifest.skills) {
    await lstat(safePath(root, `${skill}/SKILL.md`));
    await collect(skill);
  }
  for (const plugin of manifest.plugins) await collect(plugin);
  return files;
}

export function filesChecksum(files: Record<string, Uint8Array>): string {
  return digest(JSON.stringify(Object.keys(files).sort().map(name => [name, digest(files[name]!)])));
}

export async function loadProfile(root: string): Promise<LoadedProfile> {
  const files = await sourceFiles(root);
  return { root: path.resolve(root), manifest: profileSchema.parse(JSON.parse(Buffer.from(files['profile.json']!).toString())), checksum: filesChecksum(files) };
}

export async function loadProfiles(extraRoot?: string): Promise<LoadedProfile[]> {
  const profiles = new Map<string, LoadedProfile>();
  for (const root of [builtinRoot, extraRoot].filter((item): item is string => Boolean(item))) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const loaded = await loadProfile(path.join(root, entry.name));
      const existing = profiles.get(loaded.manifest.id);
      if (existing?.checksum === loaded.checksum) continue;
      if (existing) throw new Error(`Duplicate profile ID ${loaded.manifest.id}. Fork with a new ID.`);
      profiles.set(loaded.manifest.id, loaded);
    }
  }
  return [...profiles.values()];
}

export async function createProfile(root: string, id: string, harness: Profile['harness']): Promise<void> {
  await mkdir(path.dirname(path.resolve(root)), { recursive: true });
  await mkdir(root, { recursive: false });
  const manifest = profileSchema.parse({ schemaVersion: 1, id, name: id, version: '1.0.0',
    description: `A custom ${harness} specialist`, harness, capabilities: ['implementation'],
    instructions: 'Complete the assigned task. Read project instructions. Report changes and remaining work.', skills: ['skills/working-notes'] });
  await mkdir(path.join(root, 'skills/working-notes'), { recursive: true });
  await writeFile(path.join(root, 'profile.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await writeFile(path.join(root, 'skills/working-notes/SKILL.md'), '---\nname: working-notes\ndescription: Keep a concise handoff after making changes.\n---\nRecord files changed, decisions, and remaining work. Do not claim unperformed checks.\n');
}

export async function forkProfile(source: LoadedProfile, target: string, id: string): Promise<void> {
  const manifest = profileSchema.parse({ ...source.manifest, id, name: id, version: '1.0.0', forkedFrom: `${source.manifest.id}:${source.manifest.version}@${source.checksum}` });
  const files = await sourceFiles(source.root);
  await mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await mkdir(target, { recursive: false });
  for (const [name, data] of Object.entries(files)) {
    const dest = safePath(target, name);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, name === 'profile.json' ? JSON.stringify(manifest, null, 2) + '\n' : data, { flag: 'wx' });
  }
}

export async function stageProfile(profile: LoadedProfile, stateRoot: string): Promise<{ root: string; skillPlugin: string }> {
  const current = await loadProfile(profile.root);
  if (current.checksum !== profile.checksum) throw new Error(`Profile ${profile.manifest.id} changed. Reload and trust its new checksum.`);
  const root = path.join(stateRoot, 'staged', profile.checksum);
  await mkdir(root, { recursive: true });
  const files = await sourceFiles(profile.root);
  for (const [name, data] of Object.entries(files)) {
    const target = safePath(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  const skillPlugin = path.join(stateRoot, 'native-skills', profile.checksum);
  await mkdir(path.join(skillPlugin, '.claude-plugin'), { recursive: true });
  await writeFile(path.join(skillPlugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: profile.manifest.id, version: profile.manifest.version }));
  const names = new Set<string>();
  for (const skill of profile.manifest.skills) {
    const name = path.posix.basename(skill);
    if (names.has(name)) throw new Error(`Duplicate skill directory: ${name}`);
    names.add(name);
    await cp(safePath(root, skill), path.join(skillPlugin, 'skills', name), { recursive: true });
  }
  return { root, skillPlugin };
}

import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import { digest, filesChecksum, loadProfile, safePath, sourceFiles } from './profiles.js';

const MAX_COMPRESSED = 10 * 1024 * 1024;
const MAX_EXPANDED = 50 * 1024 * 1024;
const lockSchema = z.object({ schemaVersion: z.literal(1), checksum: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }).strict();

// ZIP attributes must be checked before extraction; filesystem writers must never honor symlinks.
export function inspectArchive(input: Uint8Array): void {
  if (input.length > MAX_COMPRESSED) throw new Error('Bundle exceeds 10 MiB compressed.');
  const data = Buffer.from(input);
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65557); at--) {
    if (data.readUInt32LE(at) === 0x06054b50 && at + 22 + data.readUInt16LE(at + 20) === data.length) { end = at; break; }
  }
  if (end < 0) throw new Error('Invalid ZIP archive.');
  const count = data.readUInt16LE(end + 10);
  if (count < 2 || count > 1000 || data.readUInt16LE(end + 4) !== 0 || data.readUInt16LE(end + 6) !== 0 || data.readUInt16LE(end + 8) !== count) throw new Error('Unsupported ZIP archive or file count.');
  let at = data.readUInt32LE(end + 16);
  const centralEnd = at + data.readUInt32LE(end + 12);
  if (centralEnd !== end) throw new Error('Unsupported ZIP64 or invalid central directory.');
  let total = 0;
  const names = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || data.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid ZIP central entry.');
    const length = data.readUInt16LE(at + 28);
    const next = at + 46 + length + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
    if (next > end) throw new Error('Truncated ZIP entry.');
    const rawName = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(at + 46, at + 46 + length));
    const name = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName;
    safePath('/bundle', name);
    if (name.split('/').some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`Nonportable archive path: ${name}`);
    const key = rawName.normalize('NFC').toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate archive path: ${name}`);
    names.add(key);
    const mode = (data.readUInt32LE(at + 38) >>> 16) & 0xf000;
    if (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) throw new Error(`Archive contains a symlink or special file: ${name}`);
    if (data.readUInt16LE(at + 8) & 1) throw new Error('Encrypted bundles are not supported.');
    total += data.readUInt32LE(at + 24);
    if (total > MAX_EXPANDED) throw new Error('Bundle exceeds 50 MiB expanded.');
    at = next;
  }
  if (at !== centralEnd) throw new Error('Invalid ZIP directory size.');
}

export async function exportBundle(root: string, output: string): Promise<string> {
  const files = await sourceFiles(root);
  const checksum = filesChecksum(files);
  await writeFile(output, encodeBundle(files), { flag: 'wx' });
  return checksum;
}

export function encodeBundle(files: Record<string, Uint8Array>): Uint8Array {
  const checksum = filesChecksum(files);
  const names = Object.keys(files).sort();
  const lock = { schemaVersion: 1, checksum, files: Object.fromEntries(names.map(name => [name, digest(files[name]!)])) };
  const all: Record<string, Uint8Array> = { ...files, 'profile.lock.json': Buffer.from(JSON.stringify(lock, null, 2)) };
  const entries = Object.fromEntries(Object.keys(all).sort().map(name => [name, all[name]!]));
  // ZIP stores local calendar fields, so use a fixed local date rather than a timezone-dependent UTC instant.
  const zipped = zipSync(entries, { level: 6, mtime: new Date(1980, 0, 1) });
  inspectArchive(zipped);
  return zipped;
}

export async function importBundle(input: string, target: string): Promise<string> {
  const data = new Uint8Array(await readFile(input));
  inspectArchive(data);
  const files = unzipSync(data, { filter: file => {
    safePath('/bundle', file.name.endsWith('/') ? file.name.slice(0, -1) : file.name);
    if (file.originalSize > MAX_EXPANDED) throw new Error('Archive file exceeds expanded limit.');
    return !file.name.endsWith('/');
  } });
  let total = 0;
  for (const [name, value] of Object.entries(files)) {
    safePath('/bundle', name);
    total += value.length;
    if (total > MAX_EXPANDED) throw new Error('Bundle exceeds expanded limit.');
  }
  if (!files['profile.json'] || !files['profile.lock.json']) throw new Error('Bundle needs a manifest and lockfile.');
  const lock = lockSchema.parse(JSON.parse(Buffer.from(files['profile.lock.json']).toString()));
  delete files['profile.lock.json'];
  if (Object.keys(lock.files).length !== Object.keys(files).length || filesChecksum(files) !== lock.checksum) throw new Error('Bundle checksum mismatch.');
  for (const [name, content] of Object.entries(files)) if (lock.files[name] !== digest(content)) throw new Error(`File checksum mismatch: ${name}`);
  const absoluteTarget = path.resolve(target);
  try {
    await lstat(absoluteTarget);
    throw new Error(`Destination already exists: ${absoluteTarget}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(absoluteTarget), { recursive: true });
  const temp = await mkdtemp(path.join(path.dirname(absoluteTarget), '.subharness-import-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const dest = safePath(temp, name);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, content, { flag: 'wx' });
    }
    const profile = await loadProfile(temp);
    if (profile.checksum !== lock.checksum) throw new Error('Bundle has unlisted files or dependencies.');
    await writeFile(path.join(temp, 'profile.lock.json'), JSON.stringify(lock, null, 2));
    await rename(temp, absoluteTarget);
    return lock.checksum;
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

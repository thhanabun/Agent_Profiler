import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { encodeBundle, importBundle } from './bundles.js';
import { modelFor, nativeRuntime } from './adapters.js';
import { digest, filesChecksum, forkProfile, loadProfile, sourceFiles } from './profiles.js';
import { profileSchema, type LoadedProfile } from './schema.js';
import { writeJsonAtomic } from './storage.js';

export const DIGEST = z.string().regex(/^sha256:[a-f0-9]{64}$/);
// Preserve these OCI media types so images published before the rename still load.
export const IMAGE_TYPE = 'application/vnd.subharness.image.v1';
export const CONFIG_TYPE = 'application/vnd.subharness.image.config.v1+json';
export const BUNDLE_TYPE = 'application/vnd.subharness.profile.v1+zip';
export const MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const annotations = z.record(z.string(), z.string().max(4000));
const descriptorSchema = z.object({ mediaType: z.string(), digest: DIGEST, size: z.number().int().min(1).max(11 * 1024 * 1024), annotations: annotations.optional() }).strict();
export type Descriptor = z.infer<typeof descriptorSchema>;
const indexSchema = z.object({ schemaVersion: z.literal(2), mediaType: z.literal('application/vnd.oci.image.index.v1+json'), manifests: z.array(descriptorSchema).max(10000) }).strict();
const metadataSchema = z.object({
  schemaVersion: z.literal(1), profile: profileSchema, sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  runtime: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/), adapterVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/), platform: z.enum(['win32', 'linux', 'darwin']), arch: z.enum(['x64', 'arm64']) }).strict(),
  parent: DIGEST.optional(),
}).strict();
export type ImageMetadata = z.infer<typeof metadataSchema>;
export type AgentImage = { digest: string; manifest: ReturnType<typeof parseManifest>; metadata: ImageMetadata; profile: LoadedProfile };

export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item));
}

export function imageReference(value: string): { repository: string; tag?: string; digest?: string } {
  if (DIGEST.safeParse(value).success) return { repository: '', digest: value };
  const match = value.match(/^([^@]+)@(sha256:[a-f0-9]{64})$/);
  const lastColon = value.lastIndexOf(':');
  const repository = match ? match[1]! : lastColon > value.lastIndexOf('/') ? value.slice(0, lastColon) : value;
  if (!/^[a-z0-9][a-z0-9._-]*(?::\d+)?(?:\/[a-z0-9][a-z0-9._-]*)+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..') || repository.length > 240) {
    throw new Error('Use an image reference such as owner/name:1.0.0, registry/owner/name:1.0.0 or name@sha256:<digest>.');
  }
  if (match) return { repository, digest: match[2]! };
  const tag = value.slice(lastColon + 1);
  if (lastColon <= value.lastIndexOf('/') || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(tag)) throw new Error('Image references require an explicit tag or digest.');
  return { repository, tag };
}

export function parseManifest(bytes: Uint8Array) {
  if (bytes.length > 64000) throw new Error('Image manifest exceeds 64 KB.');
  const manifest = z.object({ schemaVersion: z.literal(2), mediaType: z.literal(MANIFEST_TYPE), artifactType: z.literal(IMAGE_TYPE),
    config: descriptorSchema, layers: z.array(descriptorSchema).length(1), annotations: annotations.optional() }).strict().parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  if (manifest.config.mediaType !== CONFIG_TYPE || manifest.config.size > 1024 * 1024 || manifest.layers[0]!.mediaType !== BUNDLE_TYPE || manifest.layers[0]!.size > 10 * 1024 * 1024) throw new Error('Unsupported image layers or sizes.');
  return manifest;
}

export function blobPath(store: string, checksum: string): string { return path.join(store, 'blobs', 'sha256', DIGEST.parse(checksum).slice(7)); }

export async function readBlob(store: string, descriptor: Pick<Descriptor, 'digest' | 'size'>): Promise<Buffer> {
  const file = blobPath(store, descriptor.digest);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== descriptor.size || info.size > 11 * 1024 * 1024) throw new Error(`Image blob size/type mismatch: ${descriptor.digest}`);
  const bytes = await readFile(file);
  if (`sha256:${digest(bytes)}` !== descriptor.digest) throw new Error(`Image checksum mismatch: ${descriptor.digest}`);
  return bytes;
}

async function putBlob(store: string, bytes: Uint8Array, mediaType: string): Promise<Descriptor> {
  const descriptor = { mediaType, digest: `sha256:${digest(bytes)}`, size: bytes.length };
  const file = blobPath(store, descriptor.digest);
  await mkdir(path.dirname(file), { recursive: true });
  try { await lstat(file); await readBlob(store, descriptor); return descriptor; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = await mkdtemp(path.join(store, '.blob-'));
  try {
    await writeFile(path.join(temporary, 'content'), bytes, { flag: 'wx', mode: 0o600 });
    await rename(path.join(temporary, 'content'), file);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return descriptor;
}

async function index(store: string) {
  try { return indexSchema.parse(JSON.parse(await readFile(path.join(store, 'index.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return indexSchema.parse({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] }); }
}

export async function tagImage(store: string, reference: string, descriptor: Descriptor): Promise<void> {
  imageReference(reference);
  if (!imageReference(reference).tag) throw new Error('A local tag requires name:version.');
  const saved = await index(store);
  const existing = saved.manifests.find(item => item.annotations?.['org.opencontainers.image.ref.name'] === reference);
  if (existing && existing.digest !== descriptor.digest) throw new Error(`Tag ${reference} already identifies another image. Use a new version.`);
  if (!existing) saved.manifests.push({ ...descriptor, annotations: { 'org.opencontainers.image.ref.name': reference } });
  await writeJsonAtomic(path.join(store, 'oci-layout'), { imageLayoutVersion: '1.0.0' });
  await writeJsonAtomic(path.join(store, 'index.json'), saved);
}

export async function resolveImage(store: string, reference: string): Promise<Descriptor> {
  const parsed = imageReference(reference);
  if (parsed.digest) {
    const file = blobPath(store, parsed.digest);
    const size = (await lstat(file)).size;
    if (size > 64000) throw new Error('Image manifest exceeds 64 KB.');
    return { mediaType: MANIFEST_TYPE, digest: parsed.digest, size };
  }
  const entry = (await index(store)).manifests.find(item => item.annotations?.['org.opencontainers.image.ref.name'] === reference);
  if (!entry) throw new Error(`Image not installed: ${reference}. Run workerdeck pull ${reference} first.`);
  return entry;
}

export async function loadImage(store: string, reference: string): Promise<AgentImage> {
  const descriptor = await resolveImage(store, reference);
  const manifest = parseManifest(await readBlob(store, descriptor));
  const metadata = metadataSchema.parse(JSON.parse((await readBlob(store, manifest.config)).toString('utf8')));
  if (!metadata.profile.model) throw new Error('Image must specify a native model/provider reference.');
  const bundle = await readBlob(store, manifest.layers[0]!);
  const cacheRoot = path.join(store, 'unpacked');
  await mkdir(cacheRoot, { recursive: true });
  const target = path.join(cacheRoot, descriptor.digest.slice(7));
  try { await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const temporary = await mkdtemp(path.join(store, '.unpack-'));
    try {
      await writeFile(path.join(temporary, 'source.agentpack'), bundle, { mode: 0o600 });
      await importBundle(path.join(temporary, 'source.agentpack'), path.join(temporary, 'profile'));
      await rename(path.join(temporary, 'profile'), target);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Image source cache must be a regular directory.');
  const profile = await loadProfile(target);
  if (profile.checksum !== metadata.sourceChecksum || !jsonBytes(profile.manifest).equals(jsonBytes(metadata.profile))) throw new Error('Image source cache or metadata was modified. Remove the corrupted cache and pull again.');
  profile.image = { digest: descriptor.digest, runtimeVersion: metadata.runtime.version, adapterVersion: metadata.runtime.adapterVersion,
    platform: metadata.runtime.platform, arch: metadata.runtime.arch, parent: metadata.parent };
  return { digest: descriptor.digest, manifest, metadata, profile };
}

export async function buildImage(store: string, source: LoadedProfile, tag: string, options: { model?: string; runtime?: ImageMetadata['runtime'] } = {}): Promise<AgentImage> {
  if (!imageReference(tag).tag) throw new Error('Build needs --tag owner/name:version.');
  const files = await sourceFiles(source.root);
  if (filesChecksum(files) !== source.checksum) throw new Error('Profile source changed during build. Reload it and build again.');
  const profile = profileSchema.parse({ ...source.manifest, model: options.model ?? modelFor(source) });
  if (!profile.model) throw new Error('Images require an explicit model. Set profile.json model or build with --model provider/model.');
  files['profile.json'] = Buffer.from(JSON.stringify(profile, null, 2) + '\n');
  // Native local plugin/skill bytes are locked. External package resolution is not supported in this first format.
  for (const [name, bytes] of Object.entries(files)) if (path.posix.basename(name) === 'package.json') {
    const pkg = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.optionalDependencies ?? {}).length) throw new Error(`External dependencies in ${name} are not supported by locked images yet. Use self-contained sources.`);
  }
  let parent: string | undefined, parentText: string | undefined;
  try {
    parentText = await readFile(path.join(source.root, 'image.parent.json'), 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (parentText !== undefined) {
    const parentFile = z.object({ schemaVersion: z.literal(1), digest: DIGEST }).strict().parse(JSON.parse(parentText));
    const base = await loadImage(store, parentFile.digest);
    if (base.profile.manifest.harness !== profile.harness) throw new Error('A derived image must use the same harness as its base.');
    parent = base.digest;
  }
  const runtime = options.runtime ?? await nativeRuntime(profile.harness);
  const metadata = metadataSchema.parse({ schemaVersion: 1, profile, sourceChecksum: filesChecksum(files), runtime, parent });
  const config = await putBlob(store, jsonBytes(metadata), CONFIG_TYPE);
  const layer = await putBlob(store, encodeBundle(files), BUNDLE_TYPE);
  const manifest = jsonBytes({ schemaVersion: 2, mediaType: MANIFEST_TYPE, artifactType: IMAGE_TYPE, config,
    layers: [{ ...layer, annotations: { 'org.opencontainers.image.title': 'profile.agentpack' } }] });
  const descriptor = await putBlob(store, manifest, MANIFEST_TYPE);
  await loadImage(store, descriptor.digest);
  await tagImage(store, tag, descriptor);
  return loadImage(store, tag);
}

export async function forkImage(store: string, reference: string, target: string, newId: string): Promise<void> {
  const image = await loadImage(store, reference);
  await forkProfile(image.profile, target, newId);
  await writeJsonAtomic(path.join(target, 'image.parent.json'), { schemaVersion: 1, digest: image.digest });
}

export async function listImages(store: string) {
  const entries = [];
  for (const descriptor of (await index(store)).manifests) {
    const reference = descriptor.annotations?.['org.opencontainers.image.ref.name'];
    if (!reference) continue;
    const image = await loadImage(store, reference);
    entries.push({ reference, digest: image.digest, name: image.metadata.profile.name, description: image.metadata.profile.description,
      harness: image.metadata.profile.harness, tags: image.metadata.profile.capabilities });
  }
  return entries;
}

export async function diffImages(store: string, before: string, after: string) {
  const a = await loadImage(store, before), b = await loadImage(store, after);
  const left = await sourceFiles(a.profile.root), right = await sourceFiles(b.profile.root);
  return { before: a.digest, after: b.digest, model: [a.metadata.profile.model, b.metadata.profile.model],
    runtime: [a.metadata.runtime, b.metadata.runtime], parent: b.metadata.parent,
    files: [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(name => !left[name] || !right[name] || digest(left[name]!) !== digest(right[name]!)) };
}

export async function copyImage(sourceStore: string, destinationStore: string, reference: string, tag: string) {
  const image = await loadImage(sourceStore, reference);
  const descriptor = await resolveImage(sourceStore, image.digest);
  for (const item of [descriptor, image.manifest.config, ...image.manifest.layers]) await putBlob(destinationStore, await readBlob(sourceStore, item), item.mediaType);
  await loadImage(destinationStore, image.digest);
  await tagImage(destinationStore, tag, descriptor);
  return loadImage(destinationStore, tag);
}

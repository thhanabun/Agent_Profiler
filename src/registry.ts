import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { digest } from './profiles.js';
import { copyImage, DIGEST, imageReference, jsonBytes, listImages, loadImage, parseManifest, resolveImage, tagImage } from './images.js';

export type RegistryOptions = { plainHttp?: boolean; registryConfig?: string };

export async function findOras(): Promise<string> {
  const explicit = process.env.WORKERDECK_ORAS_BIN;
  if (explicit && /\.(cmd|bat|ps1)$/i.test(explicit)) throw new Error('WORKERDECK_ORAS_BIN must be a native executable.');
  const candidates = explicit ? [path.resolve(explicit)] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, process.platform === 'win32' ? 'oras.exe' : 'oras'));
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch { /* Continue executable discovery. */ } }
  throw new Error('Install ORAS CLI 1.3+ from https://oras.land/docs/installation/ or set WORKERDECK_ORAS_BIN. Build/inspect/run local images do not need ORAS.');
}

async function oras(args: string[], maximum = 1024 * 1024): Promise<string> {
  try { return (await promisify(execFile)(await findOras(), args, { windowsHide: true, timeout: 180000, maxBuffer: maximum, encoding: 'utf8' })).stdout; }
  catch (error) {
    const detail = error as Error & { stderr?: string };
    throw new Error(`ORAS: ${detail.stderr?.trim() || detail.message}\nAuthenticate with 'oras login <registry>' for push/private pull.`);
  }
}

export function remoteReference(reference: string): string {
  const parsed = imageReference(reference);
  if (!parsed.repository) throw new Error('Remote operations require registry/repository plus tag or digest.');
  const first = parsed.repository.split('/')[0]!;
  const host = first === 'localhost' || /[.:]/.test(first) ? '' : 'registry-1.docker.io/';
  return `${host}${parsed.repository}${parsed.digest ? `@${parsed.digest}` : `:${parsed.tag}`}`;
}

function flags(reference: string, options: RegistryOptions, side = ''): string[] {
  const args: string[] = [];
  if (options.plainHttp) {
    if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(reference)) throw new Error('--plain-http is restricted to loopback development registries.');
    args.push(`--${side}plain-http`);
  }
  if (options.registryConfig) args.push(`--${side}registry-config`, path.resolve(options.registryConfig));
  return args;
}

export async function pullImage(store: string, reference: string, options: RegistryOptions = {}) {
  const remote = remoteReference(reference), parsed = imageReference(remote);
  const raw = Buffer.from(await oras(['manifest', 'fetch', ...flags(remote, options), remote], 128 * 1024));
  parseManifest(raw);
  const expected = `sha256:${digest(raw)}`;
  if (parsed.digest && parsed.digest !== expected) throw new Error('Registry returned the wrong manifest checksum.');
  await mkdir(store, { recursive: true });
  const temporary = await mkdtemp(path.join(store, '.pull-'));
  try {
    await oras(['cp', ...flags(remote, options, 'from-'), '--to-oci-layout-path', temporary, `${parsed.repository}@${expected}`, 'image:downloaded']);
    const downloaded = await loadImage(temporary, expected);
    if (downloaded.digest !== expected) throw new Error('Pulled image digest mismatch.');
    // Preserve the user's spelling while every run records the resolved content digest.
    const localTag = imageReference(reference).tag ? reference : `${parsed.repository}:digest-${expected.slice(7)}`;
    return await copyImage(temporary, store, expected, localTag);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function pushImage(store: string, reference: string, target = reference, options: RegistryOptions = {}) {
  const image = await loadImage(store, reference), remote = remoteReference(target);
  if (!imageReference(remote).tag) throw new Error('Push target must include a tag.');
  let previous: string | undefined;
  try { previous = await oras(['manifest', 'fetch', ...flags(remote, options), remote], 128 * 1024); }
  catch (error) { if (!/\b404\b|not found|MANIFEST_UNKNOWN|NAME_UNKNOWN/i.test(String(error))) throw error; }
  if (previous && `sha256:${digest(Buffer.from(previous))}` !== image.digest) throw new Error('Remote tag already identifies different content. Push a new version.');
  await oras(['cp', '--from-oci-layout-path', store, ...flags(remote, options, 'to-'), image.digest, remote]);
  const actual = Buffer.from(await oras(['manifest', 'fetch', ...flags(remote, options), remote], 128 * 1024));
  if (`sha256:${digest(actual)}` !== image.digest) throw new Error('Registry did not preserve the image digest.');
  await tagImage(store, remote, await resolveImage(store, image.digest));
  return { reference: remote, digest: image.digest };
}

const entrySchema = z.object({ reference: z.string().max(400).refine(value => { try { imageReference(value); return true; } catch { return false; } }),
  digest: DIGEST, name: z.string().max(80), description: z.string().max(2000), harness: z.enum(['opencode', 'claude', 'codex']), tags: z.array(z.string().max(120)).max(20) }).strict();
const catalogSchema = z.object({ schemaVersion: z.literal(1), images: z.array(entrySchema).max(2000) }).strict();

export async function exportCatalog(store: string, output: string): Promise<void> {
  const catalog = catalogSchema.parse({ schemaVersion: 1, images: await listImages(store) });
  const text = JSON.stringify(catalog, null, 2) + '\n';
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Catalog exceeds 1 MiB. Split it into smaller catalogs.');
  await mkdir(path.dirname(output), { recursive: true });
  try { await writeFile(output, text, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Catalog destination already exists. Choose a new filename.'); throw error; }
}

export async function searchCatalog(store: string, query: string, catalog?: string) {
  let entries;
  if (!catalog) entries = await listImages(store);
  else {
    let bytes: Buffer;
    if (/^https?:\/\//.test(catalog)) {
      const url = new URL(catalog);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Remote catalogs require HTTPS without embedded credentials.');
      const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok || !response.body) throw new Error(`Catalog request failed (${response.status}).`);
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error('Catalog exceeds 1 MiB.'); }
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    } else {
      const { stat } = await import('node:fs/promises');
      if ((await stat(catalog)).size > 1024 * 1024) throw new Error('Catalog exceeds 1 MiB.');
      bytes = await readFile(catalog);
    }
    entries = catalogSchema.parse(JSON.parse(bytes.toString('utf8'))).images;
  }
  return entries.filter(entry => jsonBytes(entry).toString('utf8').toLowerCase().includes(query.toLowerCase()));
}

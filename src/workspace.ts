import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { digest } from './profiles.js';

const exec = promisify(execFile);
const privatePath = /(^|[\\/])(?:\.git|\.workerdeck|\.subharness|node_modules|\.env(?:\..*)?|auth\.json|\.?credentials(?:\..*)?|.*\.(?:pem|key))($|[\\/])/i;

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['--no-pager', ...args], { cwd, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 15000, windowsHide: true });
  return stdout;
}

export type Snapshot = { hashes: Record<string, string>; text: Record<string, string> };

export async function snapshot(cwd: string, stateRoot?: string): Promise<Snapshot> {
  const excluded = (name: string) => {
    if (privatePath.test(name)) return true;
    if (!stateRoot) return false;
    const relative = path.relative(path.resolve(stateRoot), path.resolve(cwd, name));
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  let names: string[];
  try { names = (await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean); }
  catch {
    names = [];
    const walk = async (relative: string, depth: number): Promise<void> => {
      if (depth > 8 || names.length >= 2000) return;
      for (const entry of await readdir(path.join(cwd, relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (excluded(name) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(name, depth + 1);
        else if (entry.isFile()) names.push(name);
        if (names.length >= 2000) break;
      }
    };
    await walk('', 0);
  }
  const result: Record<string, string> = Object.create(null);
  const text: Record<string, string> = Object.create(null);
  let previewBytes = 0;
  // shortcut: change inspection caps at 2,000 files; use incremental filesystem tracking for large repositories.
  for (const name of [...new Set(names)].filter(name => !excluded(name)).slice(0, 2000)) {
    const file = path.resolve(cwd, name);
    const relative = path.relative(cwd, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (stat.size > 2 * 1024 * 1024) { result[name] = `${stat.size}:${stat.mtimeMs}`; continue; }
      const bytes = await readFile(file);
      result[name] = digest(bytes);
      // shortcut: retain at most 4 MiB of small text files per checkpoint; large/binary files get names only.
      if (bytes.length <= 64000 && previewBytes + bytes.length <= 4 * 1024 * 1024 && !bytes.includes(0)) {
        text[name] = bytes.toString('utf8');
        previewBytes += bytes.length;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { hashes: result, text };
}

export function changedFiles(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => before[name] !== after[name]);
}

export async function taskDiff(cwd: string, names: string[], before: Snapshot, after: Snapshot, stateRoot: string): Promise<string> {
  if (!names.length) return 'No file changes detected.';
  await mkdir(stateRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(stateRoot, 'diff-'));
  const chunks = ['Changes during this task (including any concurrent manual edits):'];
  try {
    for (const name of names) {
      const existed = Object.hasOwn(before.hashes, name), exists = Object.hasOwn(after.hashes, name);
      chunks.push(`\ndiff --git a/${name} b/${name}`);
      if ((existed && !Object.hasOwn(before.text, name)) || (exists && !Object.hasOwn(after.text, name))) {
        chunks.push('[Binary/large file or preview budget exceeded. Inspect the file locally.]'); continue;
      }
      await writeFile(path.join(temporary, 'before'), before.text[name] ?? '', { mode: 0o600 });
      await writeFile(path.join(temporary, 'after'), after.text[name] ?? '', { mode: 0o600 });
      let diff: string;
      try { diff = await git(cwd, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', path.join(temporary, 'before'), path.join(temporary, 'after')]); }
      catch (error) {
        const result = error as { code?: number; stdout?: string };
        if (result.code !== 1 || typeof result.stdout !== 'string') throw error;
        diff = result.stdout;
      }
      chunks.push(`--- ${existed ? `a/${name}` : '/dev/null'}\n+++ ${exists ? `b/${name}` : '/dev/null'}`);
      const hunk = diff.indexOf('@@');
      chunks.push(hunk >= 0 ? diff.slice(hunk) : existed !== exists ? (exists ? '[Empty file created]' : '[Empty file deleted]') : '[No text difference]');
      if (chunks.join('\n').length > 20000) break;
    }
    const text = chunks.join('\n');
    return text.length > 20000 ? `${text.slice(0, 20000)}\n[Preview truncated. Inspect remaining files locally.]` : text;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

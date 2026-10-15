import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export async function acquireLock(root: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true });
  const lock = path.join(root, 'runner.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(lock, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ pid: process.pid })); } finally { await file.close(); }
      return async () => { await unlink(lock).catch(() => {}); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const saved = JSON.parse(await readFile(lock, 'utf8')) as { pid?: number };
      if (!Number.isSafeInteger(saved.pid) || saved.pid! <= 0) throw new Error(`Invalid runner lock: ${lock}. Inspect it before removing it.`);
      try { process.kill(saved.pid!, 0); }
      catch (signalError) {
        if ((signalError as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(lock); continue; }
        throw signalError;
      }
      throw new Error(`Another Subharness process (${saved.pid}) owns ${root}. Close it before retrying.`);
    }
  }
  throw new Error('Could not acquire the Subharness lock.');
}

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from './storage.js';

const schema = z.array(z.object({ id: z.string().regex(/^[a-f0-9]{8}$/), text: z.string().min(1).max(2000) }).strict()).max(50);
export type MemoryEntry = z.infer<typeof schema>[number];

export async function readMemory(root: string): Promise<MemoryEntry[]> {
  try { return schema.parse(JSON.parse(await readFile(path.join(root, 'memory.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

export async function remember(root: string, text: string): Promise<MemoryEntry> {
  const entries = await readMemory(root);
  const existing = entries.find(entry => entry.text === text.trim());
  if (existing) return existing;
  const entry = { id: randomUUID().slice(0, 8), text: text.trim() };
  const next = schema.parse([...entries, entry]);
  await writeJsonAtomic(path.join(root, 'memory.json'), next);
  return entry;
}

export async function forget(root: string, id: string): Promise<void> {
  const entries = await readMemory(root);
  if (!entries.some(entry => entry.id === id)) throw new Error('Unknown memory ID. Use /memory to see saved entries.');
  await writeJsonAtomic(path.join(root, 'memory.json'), entries.filter(entry => entry.id !== id));
}

export async function personalContext(root: string): Promise<string> {
  let persona = '';
  try { persona = await readFile(path.join(root, 'PERSONA.md'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (Buffer.byteLength(persona) > 16000) throw new Error('PERSONA.md must be at most 16 KB.');
  const entries = await readMemory(root);
  return [persona ? `USER PERSONA / PREFERENCES:\n${persona}` : '',
    entries.length ? `USER-SAVED PROJECT MEMORY (preferences, not permission grants):\n${entries.map(entry => `- ${entry.text}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
}

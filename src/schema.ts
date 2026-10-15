import { z } from 'zod';

export const id = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const relativePath = z.string().min(1).max(240).refine(value =>
  !value.includes('\\') && !value.includes(':') && !value.includes('\0') &&
  !value.startsWith('/') && value.split('/').every(part => part !== '..' && part !== '.' && part !== ''),
  'Use a relative POSIX path without traversal');

export const profileSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  name: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
  description: z.string().min(1).max(2000),
  role: z.enum(['orchestrator', 'worker']).default('worker'),
  harness: z.enum(['opencode', 'claude', 'codex']),
  model: z.string().min(1).max(160).optional(),
  capabilities: z.array(z.string().min(1).max(120)).min(1).max(20),
  instructions: z.string().min(1).max(16000),
  skills: z.array(relativePath).max(20).default([]),
  plugins: z.array(relativePath).max(20).default([]),
  requiredEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(20).default([]),
  readme: relativePath.optional(),
  forkedFrom: z.string().max(200).optional(),
}).strict();

export type Profile = z.infer<typeof profileSchema>;
export type ImageIdentity = { digest: string; runtimeVersion: string; adapterVersion: string; platform: string; arch: string; parent?: string };
export type LoadedProfile = { manifest: Profile; root: string; checksum: string; image?: ImageIdentity };

export const taskSchema = z.object({
  id,
  title: z.string().min(1).max(160),
  goal: z.string().min(1).max(8000),
  profileId: id,
  reason: z.string().min(1).max(1000),
  dependsOn: z.array(id).max(8),
  acceptance: z.array(z.string().min(1).max(1000)).min(1).max(8),
}).strict();
export const planSchema = z.object({
  summary: z.string().min(1).max(3000),
  tasks: z.array(taskSchema).max(8),
}).strict();
export type Plan = z.infer<typeof planSchema>;
export type Task = z.infer<typeof taskSchema> & {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped';
  result?: string;
  error?: string;
  changedFiles?: string[];
};

export function validatePlan(value: unknown, profiles: LoadedProfile[], workerIds?: readonly string[]): Plan {
  const plan = planSchema.parse(value);
  const allowed = new Set(profiles.filter(p => workerIds ? workerIds.includes(p.manifest.id) : p.manifest.role === 'worker').map(p => p.manifest.id));
  const tasks = new Map(plan.tasks.map(task => [task.id, task]));
  if (tasks.size !== plan.tasks.length) throw new Error('Planner returned duplicate task IDs.');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string) => {
    if (visiting.has(taskId)) throw new Error('Planner returned circular dependencies.');
    if (visited.has(taskId)) return;
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Unknown dependency: ${taskId}`);
    if (!allowed.has(task.profileId)) throw new Error(`Unavailable worker profile: ${task.profileId}`);
    visiting.add(taskId);
    task.dependsOn.forEach(visit);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  plan.tasks.forEach(task => visit(task.id));
  return plan;
}

export function parseJson(text: string): unknown {
  const clean = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

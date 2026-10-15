import { z } from 'zod';
import type { Session, View } from './engine.js';
import type { ImageIdentity, Profile } from './schema.js';

export type ReadinessCheck = {
  kind: 'source' | 'environment' | 'plugins' | 'native' | 'image' | 'provider';
  status: 'passed' | 'blocked' | 'unverified';
  reason: string;
  action?: string;
};
export type ProfileAvailability = { available: boolean; reason: string; checks?: ReadinessCheck[] };
export type Availability = Record<string, ProfileAvailability>;
export type ProfileReadiness = ProfileAvailability & {
  reference: string;
  checkedAt: string;
  checks: ReadinessCheck[];
  profileId?: string;
  harness?: Profile['harness'];
  model?: string;
  checksum?: string;
  image?: ImageIdentity;
};

const sessionId = z.uuid();
const ref = z.string().min(1).max(4096);
export const methodSchemas = {
  'profiles.list': z.object({}).strict(),
  'profiles.choices': z.object({}).strict(),
  'profiles.readiness': z.object({ reference: ref }).strict(),
  'session.list': z.object({}).strict(),
  'session.create': z.object({ title: z.string().trim().min(1).max(160).optional(), orchestrator: ref.optional(), workers: z.array(ref).max(32).optional(), direct: ref.optional() }).strict(),
  'session.open': z.object({ sessionId: z.union([sessionId, z.literal('latest')]) }).strict(),
  'session.get': z.object({ sessionId }).strict(),
  'session.rename': z.object({ sessionId, title: z.string().trim().min(1).max(160) }).strict(),
  'session.submit': z.object({ sessionId, text: z.string().trim().min(1).max(16000) }).strict(),
  'session.stop': z.object({ sessionId }).strict(),
  'session.pause': z.object({ sessionId }).strict(),
  'session.resume': z.object({ sessionId }).strict(),
  'session.retry': z.object({ sessionId, taskId: z.string().max(200).optional() }).strict(),
  'session.assign': z.object({ sessionId, taskId: z.string().min(1).max(200), profileId: z.string().min(1).max(80) }).strict(),
  'request.respond': z.object({ sessionId, requestId: z.uuid(), answer: z.string().max(16000) }).strict(),
};
export type ProtocolMethod = keyof typeof methodSchemas;
export const protocolMethods = Object.keys(methodSchemas) as ProtocolMethod[];
export const requestSchema = z.object({ version: z.literal(1), id: z.string().min(1).max(128),
  method: z.enum(protocolMethods as [ProtocolMethod, ...ProtocolMethod[]]), params: z.unknown() }).strict();
export type ProtocolRequest = { [M in ProtocolMethod]: {
  version: 1; id: string; method: M; params: z.infer<(typeof methodSchemas)[M]>;
} }[ProtocolMethod];

// Validate both the envelope and the method-specific params at the host boundary.
export function parseRequest(value: unknown): ProtocolRequest {
  const request = requestSchema.parse(value);
  return { ...request, params: methodSchemas[request.method].parse(request.params ?? {}) } as ProtocolRequest;
}

export type ProfileSummary = Profile & { source: string; checksum: string };
export type ProfileChoiceSummary = ProfileSummary & { reference: string; image?: ImageIdentity };
export type ProtocolResults = {
  'profiles.list': ProfileSummary[];
  'profiles.choices': ProfileChoiceSummary[];
  'profiles.readiness': ProfileReadiness;
  'session.list': Array<{ id: string; title: string; demo: boolean; updatedAt: string; configuration?: Session['configuration'] }>;
  'session.create': View;
  'session.open': View;
  'session.get': View;
  'session.rename': null;
  'session.submit': { accepted: true };
  'session.stop': null;
  'session.pause': null;
  'session.resume': { accepted: true };
  'session.retry': { accepted: true };
  'session.assign': null;
  'request.respond': null;
};
export type ProtocolResponse<M extends ProtocolMethod = ProtocolMethod> =
  | { version: 1; id: string; ok: true; result: ProtocolResults[M] }
  | { version: 1; id: string | null; ok: false; error: string };
export type ProtocolEvent =
  | { version: 1; event: 'ready'; methods: ProtocolMethod[] }
  | { version: 1; event: 'session.state'; sequence: number; sessionId: string; state: View }
  | { version: 1; event: 'operation.error'; sessionId: string; error: string };
export type ProtocolMessage = ProtocolResponse | ProtocolEvent;
export type { Session, View } from './engine.js';

// Mission contracts are separate from coding sessions in src/schema.ts.
// These are TypeScript contracts, not runtime validation. Validate all API inputs on the server.
export type MissionStatus = 'draft' | 'running' | 'needs_input' | 'ready_for_review' | 'failed';
export type TaskStatus = 'ready' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'stale' | 'cancelled';
export type TaskKey = 'intake' | 'budget_capacity' | 'agenda' | 'event_content' | 'validate_bundle';
export type ArtifactKind = 'budget' | 'agenda' | 'event' | 'audio';

export interface WorkshopInputs {
  topic: string;
  audience: string;
  date: string; // YYYY-MM-DD; Asia/Bangkok
  startTime: string;
  endTime: string;
  attendees: number; // Integer, 1..200
  maxBudgetThb: number; // Nonnegative integer; agree an upper bound before implementing.
  venueId: string;
}

export interface Mission {
  id: string;
  title: string;
  goal: string;
  template: 'workshop-launch';
  inputs: WorkshopInputs | null; // Null until intake is confirmed.
  revision: number;
  runId: string | null;
  generation: number;
  stopEpoch: number;
  executionState: MissionStatus;
  publishedBundleId: string | null; // Publication is independent of executionState.
}

export interface MissionFile {
  id: string;
  name: string;
  version: number;
  contentHash: string;
}

export interface MissionTask {
  id: string;
  key: TaskKey;
  status: TaskStatus;
  inputHash: string;
  dependsOn: TaskKey[];
  error?: string;
}

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  version: number;
  inputHash: string;
  outputHash: string;
  provenance: { fileIds: string[]; taskId: string };
  content: unknown; // Core owner must add kind-specific schemas before rendering real output.
}

export interface Bundle {
  id: string;
  revision: number;
  artifactIds: string[];
  checks: { code: string; passed: boolean; summary: string }[];
}

export interface MissionState {
  mission: Mission;
  files: MissionFile[];
  tasks: MissionTask[];
  artifacts: Artifact[];
  draftBundle: Bundle | null;
  decisions: { id: string; summary: string; options: { id: string; label: string }[] }[];
}

// Public allowlist: never return the entire MissionState to a visitor.
export interface PublishedEvent {
  slug: string;
  bundleId: string;
  topic: string;
  description: string;
  date: string;
  startTime: string;
  endTime: string;
  venueName: string;
  capacity: number;
  registrationCount: number;
}

export interface RegistrationReceipt {
  id: string;
  missionId: string;
  bundleId: string;
  nickname: string;
  createdAt: string;
}

export type ApiErrorCode = 'NOT_IMPLEMENTED' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'VALIDATION_ERROR'
  | 'REVISION_CONFLICT' | 'BUNDLE_CHANGED' | 'CAPACITY_FULL' | 'IDEMPOTENCY_CONFLICT' | 'QUOTA_EXCEEDED';
export type ApiResult<T> = { ok: true; data: T } | {
  ok: false; error: { code: ApiErrorCode; message: string; retryable: boolean; requiredUserAction?: string };
};

// Transport-neutral. Backend owner maps these methods to HTTP and validates runtime schemas.
export interface MissionApi {
  listMissions(): Promise<Mission[]>;
  createMission(input: { title: string; goal: string }): Promise<MissionState>;
  getMission(id: string): Promise<MissionState>;
  updateMission(id: string, input: { expectedRevision: number; inputs: WorkshopInputs }): Promise<MissionState>;
  startReadyTasks(id: string, input: { expectedRevision: number }): Promise<MissionState>;
  cancelMission(id: string, input: { expectedRevision: number; expectedStopEpoch: number }): Promise<MissionState>;
  approveAndPublish(id: string, input: { bundleId: string; expectedRevision: number }): Promise<PublishedEvent>;
  getPublishedEvent(slug: string): Promise<PublishedEvent>;
  submitRegistration(slug: string, input: { nickname: string; clientRequestId: string; seenBundleId: string }): Promise<RegistrationReceipt>;
  exportRegistrations(id: string): Promise<string>;
}

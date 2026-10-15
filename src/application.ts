import path from 'node:path';
import { Engine, listSessions, readSession } from './engine.js';
import { loadProfile, loadProfiles } from './profiles.js';
import { imageReference, listImages, loadImage } from './images.js';
import { acquireLock } from './storage.js';
import { runDemo } from './demo.js';
import { inspectProfiles, modelFor } from './adapters.js';
import type { ProfileReadiness, ReadinessCheck } from './contracts.js';
import type { LoadedProfile } from './schema.js';

export type CreateSession = { title?: string; orchestrator?: string; workers?: string[]; direct?: string };
export type ProfileChoice = { reference: string; profile: LoadedProfile };
type EngineOptions = ConstructorParameters<typeof Engine>[0];

// The CLI/stdio host owns the project lock for this manager's lifetime.
export class SessionManager {
  active?: Engine;
  private changing?: Promise<Engine>;
  private closing = false;
  constructor(readonly options: { cwd: string; stateRoot: string; store: string; extraRoot: string; demo?: boolean;
    runner?: EngineOptions['runner']; inspect?: EngineOptions['inspect'] }) {}

  async profiles(): Promise<LoadedProfile[]> { return loadProfiles(this.options.extraRoot); }
  async readiness(reference: string): Promise<ProfileReadiness> {
    let profile: LoadedProfile;
    try { profile = await this.resolve(reference); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { reference, checkedAt: new Date().toISOString(), available: false, reason,
        checks: [{ kind: 'source', status: 'blocked', reason, action: 'Repair profile.json and its declared skill/plugin files, or pull/build the referenced image, then check again.' }] };
    }
    const result = (await (this.options.inspect ?? inspectProfiles)([profile]))[profile.manifest.id]!;
    const source: ReadinessCheck = { kind: 'source', status: 'passed', reason: 'Manifest, declared files and source checksum are valid.' };
    return { ...result, reference, checkedAt: new Date().toISOString(), profileId: profile.manifest.id, harness: profile.manifest.harness,
      model: modelFor(profile), checksum: profile.checksum, image: profile.image, checks: [source, ...(result.checks ?? [])] };
  }
  async choices(): Promise<ProfileChoice[]> {
    const choices = (await this.profiles()).map(profile => ({ reference: profile.manifest.id, profile }));
    const release = await acquireLock(this.options.store);
    try {
      const seen = new Set<string>();
      for (const entry of await listImages(this.options.store)) {
        if (seen.has(entry.digest)) continue;
        seen.add(entry.digest);
        choices.push({ reference: entry.reference, profile: (await loadImage(this.options.store, entry.digest)).profile });
      }
    } finally { await release(); }
    // Include active profiles opened by directory or digest, even if not in a catalog.
    for (const profile of this.active?.profiles ?? []) if (!choices.some(choice => choice.profile.checksum === profile.checksum && choice.profile.image?.digest === profile.image?.digest))
      choices.push({ reference: profile.image?.digest ?? profile.root, profile });
    return choices;
  }
  private change(work: () => Promise<Engine>): Promise<Engine> {
    if (this.closing) return Promise.reject(new Error('The session manager is closing.'));
    if (this.changing) return Promise.reject(new Error('A session is already being opened.'));
    if (this.active?.state.busy || this.active?.state.request) return Promise.reject(new Error('Stop the active session before switching sessions.'));
    const pending = work();
    this.changing = pending;
    return pending.finally(() => { this.changing = undefined; });
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await this.changing?.catch(() => {});
    await this.active?.shutdown();
  }
  async resolve(reference: string): Promise<LoadedProfile> {
    const local = (await this.profiles()).find(profile => profile.manifest.id === reference);
    if (local) return local;
    let image = false;
    try { imageReference(reference); image = true; } catch { /* A source directory is also accepted. */ }
    if (!image) return loadProfile(path.resolve(reference));
    const release = await acquireLock(this.options.store);
    try { return (await loadImage(this.options.store, reference)).profile; } finally { await release(); }
  }
  list() { return listSessions(this.options.stateRoot, this.options.cwd); }
  private async replace(options: Pick<EngineOptions, 'profiles' | 'session' | 'directProfileId' | 'orchestratorProfileId' | 'workerProfileIds' | 'title'>): Promise<Engine> {
    if (this.active?.state.busy) throw new Error('Stop the active session before switching sessions.');
    const next = new Engine({ ...this.options, ...options, runner: this.options.runner ?? (this.options.demo ? runDemo : undefined) });
    await this.active?.flush();
    await next.flush();
    this.active = next;
    return next;
  }
  create(input: CreateSession = {}): Promise<Engine> { return this.change(() => this.createSelected(input)); }
  private async createSelected(input: CreateSession): Promise<Engine> {
    if (input.direct && (input.orchestrator || input.workers)) throw new Error('Choose a direct profile or an orchestrator/worker team.');
    if (input.direct) {
      const profile = await this.resolve(input.direct);
      return this.replace({ profiles: [profile], directProfileId: profile.manifest.id, title: input.title });
    }
    const orchestrator = await this.resolve(input.orchestrator ?? 'orchestrator');
    const workers: LoadedProfile[] = [];
    if (input.workers) { for (const ref of input.workers) workers.push(await this.resolve(ref)); }
    else workers.push(...(await this.profiles()).filter(profile => profile.manifest.role === 'worker' && profile.manifest.id !== orchestrator.manifest.id));
    return this.replace({ profiles: [orchestrator, ...workers], title: input.title, orchestratorProfileId: orchestrator.manifest.id, workerProfileIds: workers.map(profile => profile.manifest.id) });
  }
  createTeam(profiles: LoadedProfile[], title?: string): Promise<Engine> {
    if (!profiles[0]) throw new Error('Select an orchestrator profile.');
    return this.change(() => this.replace({ profiles, title, orchestratorProfileId: profiles[0]!.manifest.id, workerProfileIds: profiles.slice(1).map(profile => profile.manifest.id) }));
  }
  open(id: string): Promise<Engine> { return this.change(() => this.openSaved(id)); }
  private async openSaved(id: string): Promise<Engine> {
    await this.active?.flush();
    const session = await readSession(this.options.stateRoot, id, this.options.cwd, this.options.demo ?? false);
    if (session.configuration) {
      const config = session.configuration;
      const profiles: LoadedProfile[] = [];
      for (const entry of config.profiles) profiles.push(await (entry.source.kind === 'image'
        ? this.resolve(entry.source.digest) : loadProfile(entry.source.path)));
      return this.replace({ profiles, session, directProfileId: config.directProfileId,
        orchestratorProfileId: config.orchestratorProfileId, workerProfileIds: config.workerProfileIds });
    }
    // Compatibility with sessions written before explicit team configuration existed.
    const images = Object.values(session.selection?.images ?? {});
    const profiles: LoadedProfile[] = [];
    if (images.length) { for (const ref of images) profiles.push(await this.resolve(ref)); }
    else profiles.push(...await this.profiles());
    return this.replace({ profiles, session, directProfileId: session.selection?.directProfileId });
  }
}

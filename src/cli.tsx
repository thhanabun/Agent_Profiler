#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { findOpenCode, inspectProfiles, modelFor, nativeRuntime } from './adapters.js';
import { exportBundle, importBundle } from './bundles.js';
import { SessionManager } from './application.js';
import { serveStdio } from './protocol.js';
import { listSessions, readSession, redact } from './engine.js';
import { getCodexAuth } from './codex.js';
import { getClaudeAuth } from './auth.js';
import { createProfile, forkProfile, loadProfile, loadProfiles } from './profiles.js';
import { id, profileSchema, type LoadedProfile } from './schema.js';
import { WorkspaceApp } from './workspace-ui.js';
import { acquireLock } from './storage.js';
import { buildImage, diffImages, forkImage, imageReference, listImages, loadImage } from './images.js';
import { exportCatalog, findOras, pullImage, pushImage, searchCatalog } from './registry.js';
import { loadTeam, lockTeam, pullTeam } from './teams.js';

const help = `Subharness · native specialist profiles, one terminal thread

  subharness [run] --cwd <project>
  subharness run --orchestrator <profile-or-image> --worker <profile-or-image>
  subharness demo --cwd <project>
  subharness run --resume <session-id|latest> --cwd <project>
  subharness run --headless --goal "Build a booking page"
  subharness run <image-ref-or-profile-directory> --cwd <project>

  subharness build <profile> --tag owner/name:1.0.0 [--model provider/model]
  subharness images
  subharness inspect <image-ref>
  subharness diff <before-image> <after-image>
  subharness pull <registry/owner/name:tag>
  subharness push <local-image> [--to registry/owner/name:tag]
  subharness catalog --out <catalog.json>
  subharness search <query> [--catalog <file-or-https-url>]
  subharness team lock <team.json>
  subharness team pull <team.json>
  subharness team run <team.json> --cwd <project>

  subharness profiles [search text]
  subharness show <profile-id-or-directory>
  subharness init <directory> --harness opencode|claude|codex
  subharness check <profile-id-or-directory>
  subharness fork <profile> --to <directory> [--id my-profile]
  subharness export <profile> --out <file.agentpack>
  subharness import <file.agentpack> --to <directory>
  subharness sessions --cwd <project>
  subharness session show <id|latest> --cwd <project>
  subharness session rename <id|latest> --title "My session" --cwd <project>
  subharness serve --stdio --cwd <project>
  subharness doctor [--harness opencode|codex|claude]

Options:
  --profiles <directory>      Extra profiles (default: <state-dir>/profiles)
  --orchestrator <ref>        Planning profile/image (default: orchestrator)
  --worker <ref>              Worker profile/image; repeat to select the team
  --title <text>              New session title
  --json                    JSON output for profiles/sessions
  --state-dir <directory>     Local history/staging (default: <cwd>/.subharness)
  --store <directory>         OCI image store (default: ~/.subharness/images)
  --plain-http               Loopback development registry only
  --registry-config <file>    ORAS/Docker registry authentication config
  --demo                     Explicit offline simulation; no models or edits
  --headless                 Print task events; noninteractive requests are denied
  --goal <text>              Initial request
  --help                    Show this help

Model overrides: SUBHARNESS_MODEL_ORCHESTRATOR, SUBHARNESS_MODEL_IMPLEMENT,
SUBHARNESS_MODEL_UI, SUBHARNESS_MODEL_CODEX. OpenCode uses provider/model;
Codex and Claude use their native model IDs.
Live mode uses the configured providers and may incur charges.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    cwd: { type: 'string' }, profiles: { type: 'string' }, 'state-dir': { type: 'string' }, orchestrator: { type: 'string' }, worker: { type: 'string', multiple: true }, title: { type: 'string' }, json: { type: 'boolean' }, stdio: { type: 'boolean' },
    demo: { type: 'boolean' }, headless: { type: 'boolean' }, goal: { type: 'string' }, resume: { type: 'string' },
    to: { type: 'string' }, out: { type: 'string' }, id: { type: 'string' }, harness: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    tag: { type: 'string' }, model: { type: 'string' }, store: { type: 'string' }, catalog: { type: 'string' },
    'plain-http': { type: 'boolean' }, 'registry-config': { type: 'string' },
  } });
  if (values.help) { process.stdout.write(help); return; }
  const cwd = await realpath(path.resolve(values.cwd ?? process.cwd()));
  const stateRoot = path.resolve(values['state-dir'] ?? path.join(cwd, '.subharness'));
  const store = path.resolve(values.store ?? (process.env.SUBHARNESS_IMAGE_STORE || path.join(homedir(), '.subharness', 'images')));
  const withStore = async <T,>(work: () => Promise<T>): Promise<T> => {
    const release = await acquireLock(store);
    try { return await work(); } finally { await release(); }
  };
  const extraRoot = path.resolve(values.profiles ?? path.join(stateRoot, 'profiles'));
  let command = positionals[0] ?? 'run';
  const imageOnly = ['images', 'inspect', 'diff', 'pull', 'push', 'catalog', 'team', 'doctor', 'sessions', 'session', 'serve'].includes(command) || (command === 'search' && Boolean(values.catalog ?? process.env.SUBHARNESS_CATALOG));
  const profiles = imageOnly ? [] : await loadProfiles(extraRoot);
  if (values.model && command !== 'build') throw new Error('--model is a build option. Images lock the model; fork and rebuild to change it. Local profiles support SUBHARNESS_MODEL_<PROFILE_ID>.');
  const demo = values.demo || command === 'demo';
  const isImage = (value?: string): boolean => { if (!value) return false; try { imageReference(value); return true; } catch { return false; } };
  const getProfile = async (value: string | undefined): Promise<LoadedProfile> => {
    if (!value) throw new Error('Provide a profile ID or directory.');
    return profiles.find(profile => profile.manifest.id === value) ?? (isImage(value) ? await withStore(async () => (await loadImage(store, value)).profile) : await loadProfile(path.resolve(value)));
  };
  const manager = new SessionManager({ cwd, stateRoot, store, extraRoot, demo });
  switch (command) {
    case 'serve': {
      if (!values.stdio) throw new Error('Usage: serve --stdio --cwd <project>');
      const release = await acquireLock(stateRoot);
      try { await serveStdio(manager); } finally { await release(); }
      return;
    }
    case 'session': {
      const action = positionals[1];
      if (!['show', 'rename'].includes(action ?? '') || !positionals[2]) throw new Error('Usage: session show|rename <id|latest> [--title text]');
      if (action === 'show') { console.log(redact(JSON.stringify(await readSession(stateRoot, positionals[2], cwd, demo), null, 2))); return; }
      if (!values.title) throw new Error('Provide --title for session rename.');
      const release = await acquireLock(stateRoot);
      try { const engine = await manager.open(positionals[2]); await engine.rename(values.title); console.log(redact(`Renamed ${engine.state.session.id}: ${engine.state.session.title}`)); } finally { await release(); }
      return;
    }
    case 'search': {
      const found = await withStore(() => searchCatalog(store, positionals.slice(1).join(' '), values.catalog ?? process.env.SUBHARNESS_CATALOG));
      for (const entry of found) console.log(redact(`${entry.reference}\n  ${entry.name} · ${entry.harness} · ${entry.digest}\n  ${entry.description}${values.catalog || process.env.SUBHARNESS_CATALOG ? '\n  Catalog entry; pull and inspect to verify contents.' : ''}`));
      if (values.catalog || process.env.SUBHARNESS_CATALOG) return;
      // Local profile discovery remains available alongside the installed image catalog.
    }
    case 'profiles': {
      const query = positionals.slice(1).join(' ').toLowerCase();
      if (values.json) { console.log(redact(JSON.stringify(profiles.filter(p => JSON.stringify(p.manifest).toLowerCase().includes(query)).map(p => ({ ...p.manifest, source: p.root, checksum: p.checksum }))))); return; }
      for (const profile of profiles.filter(profile => JSON.stringify(profile.manifest).toLowerCase().includes(query))) {
        const m = profile.manifest;
        console.log(redact(`@${m.id} ${m.version} · ${m.harness} / ${modelFor(profile) ?? 'native default'}\n  ${m.description}\n  ${m.capabilities.join(', ')}\n  ${profile.root}`));
      }
      return;
    }
    case 'build': {
      if (!values.tag) throw new Error('Usage: build <profile> --tag owner/name:version [--model provider/model]');
      const source = await getProfile(positionals[1]);
      const image = await withStore(() => buildImage(store, source, values.tag!, { model: values.model }));
      console.log(redact(`Built ${values.tag}\n${image.digest}\n${image.metadata.profile.harness} ${image.metadata.runtime.version} / ${image.metadata.profile.model}\nStore: ${store}`));
      return;
    }
    case 'images': {
      for (const entry of await withStore(() => listImages(store))) console.log(redact(`${entry.reference}\n  ${entry.harness} · ${entry.digest}\n  ${entry.description}`));
      return;
    }
    case 'inspect': {
      if (!positionals[1]) throw new Error('Usage: inspect <installed-image-ref>');
      const image = await withStore(() => loadImage(store, positionals[1]!));
      console.log(redact(JSON.stringify({ digest: image.digest, ...image.metadata, source: image.profile.root,
        dependencyLock: 'Embedded source files only. External native/project/tool dependencies are not resolved by this image format.',
        environment: 'Native user/project config remains active. Provider references may be mutable. This image is not an OS sandbox.' }, null, 2)));
      return;
    }
    case 'diff': {
      if (!positionals[1] || !positionals[2]) throw new Error('Usage: diff <before-image> <after-image>');
      console.log(redact(JSON.stringify(await withStore(() => diffImages(store, positionals[1]!, positionals[2]!)), null, 2)));
      return;
    }
    case 'pull': case 'push': {
      if (!positionals[1]) throw new Error(`Usage: ${command} <image-ref>`);
      const options = { plainHttp: values['plain-http'], registryConfig: values['registry-config'] };
      const result = await withStore(async () => command === 'pull' ? await pullImage(store, positionals[1]!, options) : await pushImage(store, positionals[1]!, values.to, options));
      console.log(redact(`${command === 'pull' ? 'Pulled and validated; no image code executed' : 'Pushed'}\n${result.digest}`));
      if ('reference' in result) console.log(result.reference);
      return;
    }
    case 'catalog': {
      if (!values.out) throw new Error('Usage: catalog --out <new-catalog.json>');
      await withStore(() => exportCatalog(store, path.resolve(values.out!)));
      console.log(`Exported ${path.resolve(values.out)}. Share the file or host it over HTTPS; pass --catalog to search it.`);
      return;
    }
    case 'show': {
      const profile = await getProfile(positionals[1]);
      console.log(redact(JSON.stringify({ ...profile.manifest, source: profile.root, checksum: profile.checksum }, null, 2)));
      return;
    }
    case 'init': {
      const target = positionals[1];
      if (!target || !profileSchema.shape.harness.safeParse(values.harness).success) throw new Error('Usage: init <directory> --harness opencode|claude|codex');
      await createProfile(path.resolve(target), id.parse(values.id ?? path.basename(target)), profileSchema.shape.harness.parse(values.harness));
      console.log(`Created ${path.resolve(target)}. Edit profile.json and skills/ with your editor.`);
      return;
    }
    case 'check': {
      const profile = await getProfile(positionals[1]);
      console.log(`Valid source: @${profile.manifest.id}\nSHA-256 ${profile.checksum}`);
      const readiness = (await inspectProfiles([profile]))[profile.manifest.id]!;
      console.log(redact(readiness.reason));
      if (!readiness.available) process.exitCode = 1;
      console.log('Native project/user configuration and machine policies can also affect this profile.');
      return;
    }
    case 'fork': {
      if (!values.to) throw new Error('Usage: fork <profile> --to <new-directory> [--id new-id]');
      const profile = await getProfile(positionals[1]);
      const newId = id.parse(values.id ?? path.basename(values.to));
      if (isImage(positionals[1])) await withStore(() => forkImage(store, positionals[1]!, path.resolve(values.to!), newId));
      else await forkProfile(profile, path.resolve(values.to), newId);
      console.log(`Forked @${profile.manifest.id} → @${newId} in ${path.resolve(values.to)}. ${isImage(positionals[1]) ? 'Base image recorded in image.parent.json. Edit source, then build with a new --tag.' : 'Edit profile.json, then include its parent with --profiles.'}`);
      return;
    }
    case 'export': {
      if (!values.out) throw new Error('Usage: export <profile> --out <new-file.agentpack>');
      const profile = await getProfile(positionals[1]);
      const checksum = await exportBundle(profile.root, path.resolve(values.out));
      console.log(`Exported ${path.resolve(values.out)}\nSHA-256 ${checksum}`);
      if (profile.image) console.log('This is a legacy source profile bundle. Use push/pull to distribute the locked OCI image.');
      return;
    }
    case 'import': {
      if (!positionals[1] || !values.to) throw new Error('Usage: import <file.agentpack> --to <new-directory>');
      const checksum = await importBundle(path.resolve(positionals[1]), path.resolve(values.to));
      console.log(`Imported ${path.resolve(values.to)}\nSHA-256 ${checksum}\nNo profile code was executed. Add the parent directory with --profiles to use it.`);
      return;
    }
    case 'doctor': {
      console.log(`Node ${process.version} · ${process.platform}/${process.arch}`);
      const harnesses = values.harness ? [profileSchema.shape.harness.parse(values.harness)] : ['opencode', 'codex', 'claude'];
      if (harnesses.includes('opencode')) try {
        const executable = await findOpenCode();
        const result = await promisify(execFile)(executable, ['--version'], { windowsHide: true, timeout: 15000 });
        console.log(`OpenCode ${redact(result.stdout.trim())} · ${executable}`);
      } catch (error) { console.error(redact(String(error))); process.exitCode = 1; }
      if (harnesses.includes('codex')) {
        const codex = await getCodexAuth();
        console.log(`Codex: ${codex.reason}`);
        if (!codex.available) process.exitCode = 1;
        else { try { console.log(`Codex ${(await nativeRuntime('codex')).version}`); } catch (error) { console.error(redact(String(error))); process.exitCode = 1; } }
      }
      if (harnesses.includes('claude')) {
        const claude = await getClaudeAuth();
        console.log(`Claude (${claude.method}): ${claude.reason}`);
        if (!claude.available) process.exitCode = 1;
      }
      console.log('This checks local setup only. No model request was made. OpenCode provider authentication must be configured with its native login.');
      try { console.log(`ORAS: ${await findOras()}`); } catch { console.log('ORAS not installed (only needed for registry push/pull).'); }
      return;
    }
    case 'sessions': {
      if (values.json) { console.log(redact(JSON.stringify((await manager.list()).map(({ session, modified }) => ({ id: session.id, title: session.title, demo: session.demo, updatedAt: session.updatedAt ?? new Date(modified).toISOString(), configuration: session.configuration }))))); return; }
      for (const { session, modified } of await listSessions(stateRoot, cwd)) {
        console.log(redact(`${session.id} · ${new Date(modified).toISOString()} · ${session.demo ? 'SIMULATION' : 'LIVE'} · ${session.title} · ${session.goal.slice(0, 100)}`));
      }
      return;
    }
    case 'run': case 'demo': break;
    case 'team': {
      if (demo) throw new Error('Team runs use the locked images. For the built-in offline preview, use subharness demo without a team.');
      if (!positionals[2] || !['lock', 'pull', 'run'].includes(positionals[1] ?? '')) throw new Error('Usage: team lock|pull|run <team.json>');
      if (positionals[1] === 'lock') {
        console.log(JSON.stringify(await withStore(() => lockTeam(store, path.resolve(positionals[2]!))), null, 2)); return;
      }
      if (positionals[1] === 'pull') {
        const team = await withStore(() => pullTeam(store, path.resolve(positionals[2]!), { plainHttp: values['plain-http'], registryConfig: values['registry-config'] }));
        console.log(redact(`Pulled ${team.team.name}: ${team.profiles.map(profile => `${profile.manifest.id}@${profile.image!.digest}`).join(', ')}\nNo image code executed.`)); return;
      }
      command = 'run'; break;
    }
    default: throw new Error(`Unknown command: ${command}. Run with --help.`);
  }
  if (values.resume && (values.orchestrator || values.worker || (command === 'run' && positionals[1]) || positionals[0] === 'team')) throw new Error('Resume restores the saved team. Use run --resume <id> without profile/team selectors.');
  const release = await acquireLock(stateRoot);
  const interactive = !values.headless && process.stdin.isTTY && process.stdout.isTTY;
  const chooseTeam = interactive && !values.resume && !values.goal && !values.orchestrator && !values.worker && !positionals[1];
  try {
    if (!chooseTeam) {
      if (values.resume) await manager.open(values.resume);
      else if (positionals[0] === 'team') await manager.createTeam((await withStore(() => loadTeam(store, path.resolve(positionals[2]!)))).profiles, values.title);
      else await manager.create({ title: values.title, direct: command === 'run' ? positionals[1] : undefined, orchestrator: values.orchestrator, workers: values.worker });
    }
  } catch (error) { await release(); throw error; }
  let exiting = false;
  let app: ReturnType<typeof render> | undefined;
  const terminate = () => {
    exiting = true;
    process.exitCode = 143;
    void manager.shutdown().catch(error => { console.error(redact(String(error))); process.exitCode = 1; }).finally(() => app?.unmount());
  };
  const interrupt = () => { exiting = true; process.exitCode = 130; manager.active?.stop(); };
  process.on('SIGTERM', terminate);
  try {
    if (!interactive) {
      const engine = manager.active!;
      if (!values.goal && !values.resume) throw new Error('Noninteractive mode needs --goal or --resume. For an offline preview use: demo --headless --goal "Build a booking page"');
      process.on('SIGINT', interrupt);
      let messageCount = 0;
      engine.on('change', () => {
        for (const message of engine.state.session.messages.slice(messageCount)) console.log(JSON.stringify(message));
        messageCount = engine.state.session.messages.length;
        if (engine.state.request) engine.answer('no');
      });
      if (values.goal) await engine.submit(values.goal);
      else await engine.resume();
      if (engine.state.error && !exiting) process.exitCode = 1;
      process.off('SIGINT', interrupt);
    } else {
      app = render(<WorkspaceApp manager={manager} initialTitle={values.title} />, { exitOnCtrlC: false, patchConsole: true, alternateScreen: true });
      if (values.goal) setTimeout(() => { if (!exiting) void manager.active?.submit(values.goal!).catch(error => { console.error(redact(String(error))); }); }, 0);
      await app.waitUntilExit();
    }
  } finally {
    process.off('SIGTERM', terminate);
    try { await manager.shutdown(); } finally { await release(); }
  }
}

main().catch(error => { console.error(redact(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });

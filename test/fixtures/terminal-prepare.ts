// Creates only a known local fixture; launch/interrupt its real TUI manually.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Engine, sessionSchema } from '../../src/engine.js';
import { createProfile, loadProfile } from '../../src/profiles.js';

const harness = process.argv[2];
if (harness !== 'opencode' && harness !== 'codex') throw new Error('Specify opencode or codex.');
const parent = path.resolve('.workerdeck/terminal'); await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, `${harness}-`)), cwd = path.join(root, 'project with spaces'), stateRoot = path.join(root, 'state');
await mkdir(cwd); const source = path.join(root, 'profiles/worker'); await createProfile(source, 'terminal-worker', harness);
const manifest = JSON.parse(await readFile(path.join(source, 'profile.json'), 'utf8'));
manifest.model = harness === 'opencode' ? process.env.WORKERDECK_TEST_OPENCODE_MODEL ?? 'opencode/muse-spark-1.3-contributor-free' : process.env.WORKERDECK_TEST_CODEX_MODEL ?? 'gpt-6.1-sol';
manifest.skills = []; manifest.instructions = 'Authorized terminal cancellation fixture. Follow YOUR TASK exactly. No tools, file changes, integrations or subagents.';
await writeFile(path.join(source, 'profile.json'), JSON.stringify(manifest));
const profile = await loadProfile(source), sessionId = randomUUID();
const task = (id: string, goal: string, dependsOn: string[]) => ({ id, title: id, goal, dependsOn, profileId: profile.manifest.id,
  reason: 'Terminal Ctrl+C fixture', acceptance: ['Requested output delivered.'], status: 'pending' });
const session = sessionSchema.parse({ version: 1, id: sessionId, cwd, demo: false, title: `Ctrl+C ${harness}`, goal: 'Terminal Ctrl+C test',
  planCount: 1, summary: 'Seeded plan; live worker only.', tasks: [task('interrupt', 'Write 500 numbered lines about a greeting function, without tools. No introduction; keep streaming every line.', []),
    task('must-not-run', 'Return DEPENDENT_SHOULD_NOT_RUN.', ['interrupt'])], messages: [], nativeSessions: {}, diffs: {} });
await new Engine({ cwd, stateRoot, profiles: [profile], session }).flush();
await writeFile(path.join(stateRoot, 'trust.json'), JSON.stringify([profile.checksum]));
const metadata = { root, cwd, stateRoot, sessionId, harness, model: manifest.model, store: path.join(root, 'images'), profiles: path.join(root, 'profiles') };
await writeFile(path.join(root, 'fixture.json'), JSON.stringify(metadata, null, 2));
console.log(JSON.stringify(metadata));

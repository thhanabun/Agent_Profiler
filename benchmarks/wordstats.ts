import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionManager } from '../src/application.js';
import { nativeRuntime, runNative } from '../src/adapters.js';
import { builtinRoot, forkProfile, loadProfile } from '../src/profiles.js';
import { redact } from '../src/engine.js';

export const taskSpec = `Build a tiny dependency-free Node.js word statistics CLI in this empty project.
Create stats.mjs exporting a synchronous function analyze(text) returning exactly {lines, words, characters}.
characters counts Unicode code points, including whitespace and line endings (not bytes, UTF-16 units or grapheme clusters).
words counts nonempty whitespace-separated tokens; empty/whitespace-only input has zero words.
lines is zero for empty input; otherwise CRLF, CR and LF are line separators, and one final separator does not create an extra line. Thus "a\\n" has one line and "\\n\\n" has two lines.
Create cli.mjs: node cli.mjs reads all UTF-8 stdin and writes exactly one JSON object from analyze plus a newline to stdout. --help prints a Usage message and exits 0; any other argument writes an error to stderr and exits 2.
Use only built-in Node modules. Allowed files: stats.mjs, cli.mjs, and optional README.md. No package installation, subagents, external services, commits or publishing.
After implementing, review edge cases and fix any issues you find. Do not run shell writes or execute tests/builds; the evaluator will run its own checks. Native file editing and read-only file inspection are permitted.
Return an honest concise handoff. A team may use at most two tasks; choose workers from its catalog.`;

export type Check = { name: string; passed: boolean; error?: string };
const cases = [
  ['empty', '', { lines: 0, words: 0, characters: 0 }],
  ['ordinary words', 'hello world', { lines: 1, words: 2, characters: 11 }],
  ['whitespace', ' \t ', { lines: 1, words: 0, characters: 3 }],
  ['trailing newline', 'a\n', { lines: 1, words: 1, characters: 2 }],
  ['blank lines', '\n\n', { lines: 2, words: 0, characters: 2 }],
  ['CRLF', 'a\r\nb\r\n', { lines: 2, words: 2, characters: 6 }],
  ['bare CR', 'a\rb', { lines: 2, words: 2, characters: 3 }],
  ['Unicode code points', '😀 ไทย', { lines: 1, words: 2, characters: 5 }],
  ['combining mark', 'e\u0301', { lines: 1, words: 1, characters: 2 }],
] as const;

function execute(cwd: string, args: string[], stdin = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile(process.execPath, args, { cwd, windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024,
      env: Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]!])) }, (error, stdout, stderr) => {
      resolve({ code: error ? typeof error.code === 'number' ? error.code : null : 0, stdout, stderr });
    });
    child.stdin!.on('error', () => {}); child.stdin!.end(stdin);
  });
}

export async function verifyWordstats(cwd: string): Promise<Check[]> {
  // The evaluator stays outside the generated project and never gives it model credentials.
  const script = `import assert from 'node:assert/strict';
const cases=${JSON.stringify(cases)};const checks=[];
try {const {analyze}=await import(${JSON.stringify(pathToFileURL(path.join(cwd, 'stats.mjs')).href)});
for(const [name,input,expected] of cases){try{assert.deepEqual(analyze(input),expected);checks.push({name,passed:true});}catch(error){checks.push({name,passed:false,error:String(error.message).slice(0,500)});}}}
catch(error){for(const [name] of cases)checks.push({name,passed:false,error:String(error.message).slice(0,500)});}
console.log(JSON.stringify(checks));`;
  const imported = await execute(cwd, ['--input-type=module', '-e', script]);
  let checks: Check[];
  try {
    if (imported.code !== 0) throw new Error(imported.stderr);
    checks = JSON.parse(imported.stdout);
    if (!Array.isArray(checks) || checks.length !== cases.length || checks.some((check, index) => check.name !== cases[index]![0] || typeof check.passed !== 'boolean')) throw new Error('Invalid evaluator output.');
  } catch { checks = cases.map(([name]) => ({ name, passed: false, error: 'Module could not be evaluated.' })); }
  for (const [name, args, input, expected] of [
    ['CLI stdin', [], '😀 ไทย\r\n', { lines: 1, words: 2, characters: 7 }],
    ['CLI empty', [], '', { lines: 0, words: 0, characters: 0 }],
  ] as const) {
    const result = await execute(cwd, ['cli.mjs', ...args], input);
    let passed = false;
    try { assert.deepEqual(JSON.parse(result.stdout), expected); passed = result.code === 0 && result.stderr === '' && result.stdout.endsWith('\n'); } catch { /* An invalid JSON response is a failed check. */ }
    checks.push({ name, passed, ...(passed ? {} : { error: `exit=${result.code}; stdout=${result.stdout.slice(0, 300)}; stderr=${result.stderr.slice(0, 300)}` }) });
  }
  const help = await execute(cwd, ['cli.mjs', '--help']);
  checks.push({ name: 'CLI help', passed: help.code === 0 && /usage/i.test(help.stdout) });
  const unknown = await execute(cwd, ['cli.mjs', '--unknown']);
  checks.push({ name: 'CLI invalid argument', passed: unknown.code === 2 && unknown.stderr.trim().length > 0 && unknown.stdout === '' });
  return checks;
}

async function main() {
  if (process.env.WORKERDECK_BENCHMARK_LIVE !== '1') throw new Error('Set WORKERDECK_BENCHMARK_LIVE=1 to run real models. This consumes provider usage.');
  const parent = path.resolve('.workerdeck/benchmarks'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'wordstats-'));
  const profilesRoot = path.join(root, 'profiles');
  const models = { opencode: process.env.WORKERDECK_TEST_OPENCODE_MODEL ?? 'opencode/muse-spark-1.3-contributor-free', codex: process.env.WORKERDECK_TEST_CODEX_MODEL ?? 'gpt-6.1-sol' };
  for (const [source, id, model] of [['orchestrator', 'bench-planner', models.opencode], ['implement', 'bench-opencode', models.opencode], ['codex', 'bench-codex', models.codex]]) {
    const destination = path.join(profilesRoot, id!);
    await forkProfile(await loadProfile(path.join(builtinRoot, source!)), destination, id!);
    const manifest = JSON.parse(await readFile(path.join(destination, 'profile.json'), 'utf8')); manifest.model = model;
    await writeFile(path.join(destination, 'profile.json'), JSON.stringify(manifest, null, 2));
  }
  const runtime = { opencode: await nativeRuntime('opencode'), codex: await nativeRuntime('codex') };
  const results = [];
  console.log(`Benchmark artifacts: ${root}`);
  for (const mode of ['codex-direct', 'team'] as const) {
    const cwd = path.join(root, mode, 'project'); await mkdir(cwd, { recursive: true });
    const manager = new SessionManager({ cwd, stateRoot: path.join(root, mode, 'state'), store: path.join(root, 'images'), extraRoot: profilesRoot, runner: runNative });
    const engine = await manager.create(mode === 'codex-direct' ? { title: mode, direct: 'bench-codex' } : { title: mode, orchestrator: 'bench-planner', workers: ['bench-opencode', 'bench-codex'] });
    const approvals: Array<{ kind: string; allowed: boolean }> = [];
    const allowed = new Set(['stats.mjs', 'cli.mjs', 'README.md'].map(file => path.join(cwd, file)));
    let lastPhase = '';
    engine.on('change', () => {
      if (engine.state.phase !== lastPhase) { lastPhase = engine.state.phase; console.log(`${mode}: ${lastPhase}`); }
      const request = engine.state.request; if (!request) return;
      let grant = request.kind === 'trust';
      try {
        const params = JSON.parse(request.detail);
        if (request.kind === 'permission') grant = Array.isArray(params.changes) && params.changes.length > 0 && !params.grantRoot && params.changes.every((change: any) =>
          allowed.has(path.resolve(cwd, change.path)) && change.kind?.type !== 'delete' && !change.kind?.move_path);
        if (request.kind === 'permission' && params.cwd && path.resolve(params.cwd) === cwd && Array.isArray(params.commandActions) && params.commandActions.length > 0)
          grant = params.commandActions.every((action: any) => action.type === 'read' && allowed.has(path.resolve(cwd, action.path)) || action.type === 'listFiles' && (!action.path || path.resolve(cwd, action.path) === cwd));
      } catch { /* Unknown prompts are denied. */ }
      approvals.push({ kind: request.kind, allowed: grant }); engine.answer(grant ? 'yes' : 'no', request.id);
    });
    const started = performance.now();
    const timeout = setTimeout(() => engine.stop(), 240000);
    try { await engine.submit(taskSpec); } finally { clearTimeout(timeout); await manager.shutdown(); }
    const seconds = (performance.now() - started) / 1000;
    const checked = performance.now(); const checks = await verifyWordstats(cwd);
    const result = { mode, seconds, verificationSeconds: (performance.now() - checked) / 1000, sessionId: engine.state.session.id,
      completed: !engine.state.error, error: engine.state.error, passed: checks.filter(check => check.passed).length, total: checks.length, checks,
      runs: engine.state.session.runs, tasks: engine.state.session.tasks.map(task => ({ id: task.id, profileId: task.profileId, status: task.status })), approvals };
    results.push(result); console.log(`${mode}: ${result.passed}/${result.total} checks in ${seconds.toFixed(2)}s`);
    await writeFile(path.join(root, 'results.json'), JSON.stringify({ benchmark: 'wordstats-v1', trials: 1, models, runtime, task: taskSpec, node: process.version, results }, null, 2));
  }
  const report = `# Wordstats benchmark\n\nOne task, one measured run per configuration. Models differ; this measures the configured workflows, not the isolated effect of a harness.\n\n| Configuration | Wall time | Checks | Native calls |\n| --- | ---: | ---: | ---: |\n${results.map(result => `| ${result.mode} | ${result.seconds.toFixed(2)}s | ${result.passed}/${result.total} | ${result.runs.length} |`).join('\n')}\n\nModel time includes startup, planning, normal native tools, approval handling and session persistence. Verification time is separate in results.json. Fresh project/session per run; order is Codex direct then team. No retries or manual fixes. Tokens/cost were not measured. One trial cannot establish a general speed or quality advantage.\n\nModels: OpenCode ${models.opencode}; Codex ${models.codex}.\n\nSee results.json for exact checks, tasks, native runs and approvals; generated projects and saved diffs are beside it.\n`;
  await writeFile(path.join(root, 'REPORT.md'), report);
  console.log(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main().catch(error => { console.error(redact(String(error))); process.exitCode = 1; });

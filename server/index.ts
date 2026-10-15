import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { cwd: { type: 'string' } } });
  if (!values.cwd) throw new Error('Usage: node --import tsx server/index.ts --cwd <project>');
  const cwd = await realpath(values.cwd);
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../bin/subharness.mjs', import.meta.url)),
    'serve', '--stdio', '--cwd', cwd,
  ], { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });

  const stop = () => {
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    child.stdin.end();
  };
  let inputError: Error | undefined;
  const inputFailed = (error: Error) => { inputError = error; stop(); };
  process.stdin.once('error', inputFailed);
  child.stdin.once('error', inputFailed);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  process.stdin.pipe(child.stdin);

  try {
    const [code] = await once(child, 'close');
    if (inputError && code === 0) throw inputError;
    process.exitCode = code ?? 1;
  } finally {
    stop();
    process.stdin.off('error', inputFailed);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

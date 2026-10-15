import { parseArgs } from 'node:util';
import { startHost } from './host.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    cwd: { type: 'string' }, port: { type: 'string' }, 'state-dir': { type: 'string' }, demo: { type: 'boolean' },
  } });
  if (!values.cwd) throw new Error('Usage: node --import tsx server/index.ts --cwd <project> [--port 5174] [--demo]');
  const host = await startHost({ cwd: values.cwd, port: values.port === undefined ? undefined : Number(values.port), stateDir: values['state-dir'], demo: values.demo });
  const stop = () => { void host.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdin.once('end', stop);
  process.stdin.resume();
  console.log(JSON.stringify({ event: 'host.ready', url: host.url, token: host.token, cwd: host.cwd, stateDir: host.stateDir, demo: host.demo }));
  try { await host.closed; }
  finally {
    process.stdin.pause();
    process.stdin.off('end', stop);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

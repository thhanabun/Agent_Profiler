import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

export type ClaudeAuth = { available: boolean; method: 'api-key' | 'cloud' | 'native-login' | 'missing'; reason: string; executable?: string };

export function claudeCloudConfigured(): boolean {
  return ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS'].some(key => process.env[key] === '1');
}

export async function findClaude(): Promise<string | undefined> {
  const explicit = process.env.WORKERDECK_CLAUDE_BIN;
  if (explicit && /\.(?:cmd|bat|ps1)$/i.test(explicit)) throw new Error('WORKERDECK_CLAUDE_BIN must point to a native executable, not a shell shim.');
  const candidates = explicit ? [path.resolve(explicit)] : [
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude')),
    path.join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
  ];
  for (const executable of candidates) {
    try { await access(executable); return executable; } catch { /* Continue native executable discovery. */ }
  }
  if (explicit) throw new Error(`Claude executable not found: ${explicit}`);
  return undefined;
}

export async function getClaudeAuth(): Promise<ClaudeAuth> {
  const executable = await findClaude();
  if (process.env.ANTHROPIC_API_KEY) return { available: true, method: 'api-key', reason: 'ANTHROPIC_API_KEY is set; native API-key billing applies.', executable };
  if (claudeCloudConfigured()) return { available: true, method: 'cloud', reason: 'Native Claude cloud-provider configuration.', executable };
  if (executable) {
    try {
      const { stdout } = await promisify(execFile)(executable, ['auth', 'status', '--json'], {
        windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024, env: process.env,
      });
      const status: unknown = JSON.parse(stdout);
      if (status && typeof status === 'object' && 'loggedIn' in status && status.loggedIn === true) {
        return { available: true, method: 'native-login', reason: 'Personal Claude CLI login found; token validity is checked on the next model call.', executable };
      }
    } catch { /* Authentication errors are surfaced as setup guidance, never raw credential output. */ }
  }
  return { available: false, method: 'missing', executable,
    reason: 'Run `claude auth login` for personal use, or configure ANTHROPIC_API_KEY / a supported cloud provider.' };
}

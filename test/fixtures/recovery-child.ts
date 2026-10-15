import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { SessionManager } from '../../src/application.js';
import { acquireLock } from '../../src/storage.js';

const root = process.argv[2]!;
const cwd = path.join(root, 'project with spaces'), stateRoot = path.join(root, 'state');
const release = await acquireLock(stateRoot);
const manager = new SessionManager({ cwd, stateRoot, store: path.join(root, 'images'), extraRoot: path.join(root, 'profiles'), demo: true,
  runner: async input => {
    input.onEvent({ kind: 'session', text: '', sessionId: 'fixture-interrupted-thread' });
    input.onEvent({ kind: 'text', text: 'CHECKPOINTED_PARTIAL_OUTPUT' });
    await writeFile(path.join(cwd, 'work.txt'), 'PRESERVED_EDIT\n');
    await manager.active!.flush();
    process.stdout.write('CHECKPOINT_READY\n');
    return await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
  } });
try { const engine = await manager.open('latest'); await engine.resume(); }
finally { await manager.shutdown(); await release(); }

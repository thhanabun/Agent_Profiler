import { spawn, type ChildProcess } from 'node:child_process';

export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 4000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (process.platform === 'win32') {
      const kill = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
      kill.once('error', () => { child.kill(); });
      kill.once('close', code => { if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill(); });
    } else {
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }, 2000).unref();
    }
  });
}


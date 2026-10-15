export function exitWithRestoreRetry(exit: () => void, platform: string = process.platform): void {
  try { exit(); }
  catch (error) {
    const failure = error as NodeJS.ErrnoException;
    // Windows ConPTY can reject its first raw-mode restore; retry cleanup once and keep real failures visible.
    if (platform !== 'win32' || failure.code !== 'EPERM' || failure.syscall !== 'setRawMode') throw error;
    exit();
  }
}

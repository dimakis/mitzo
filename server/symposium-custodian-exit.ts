/** Canonical retirement must never turn an unconfirmed app exit into a forced
 * success. The caller keeps its original child reference and fences ownership
 * when this deadline rejects, before any native retirement receipt is written. */
export async function waitOriginalControllerExit(
  child: {
    exitCode: number | null;
    signalCode: string | null;
    kill(signal: 'SIGTERM' | 'SIGKILL'): boolean;
  },
  exited: Promise<void>,
  canonical: boolean,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (canonical) {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Error('Canonical app exit uncertain; original child retained without force')),
        5000,
      );
    });
    try {
      await Promise.race([exited, deadline]);
    } finally {
      clearTimeout(timer!);
    }
  } else {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

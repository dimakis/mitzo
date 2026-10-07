// Leave room inside the capacity UI's 15-second request deadline for admission.
export const CAPACITY_REATTACH_READY_TIMEOUT_MS = 10_000;

/** Manual-only readiness fence. No timer may start a provider transport here. */
export async function retryCapacityAfterReattachment(
  target: { recoveryId: string; sourceCommandId: string },
  deps: {
    read(): { id: string; sourceCommandId: string; revision: number } | undefined;
    reattach(): Promise<'ready' | 'reattaching' | 'unavailable'>;
    retry(): Promise<'queued' | 'unavailable'>;
  },
): Promise<'queued' | 'unavailable'> {
  const before = deps.read();
  if (
    !before ||
    before.id !== target.recoveryId ||
    before.sourceCommandId !== target.sourceCommandId
  )
    throw new Error('Capacity recovery changed');
  if ((await deps.reattach()) !== 'ready') return 'unavailable';
  const current = deps.read();
  if (
    !current ||
    current.id !== before.id ||
    current.sourceCommandId !== before.sourceCommandId ||
    current.revision !== before.revision
  )
    throw new Error('Capacity recovery changed during reattachment');
  return deps.retry();
}

/** A chat operation resolves at session closure, not runtime registration. */
export async function waitForReattachedCodexRuntime(
  lifetime: Promise<void> | undefined,
  waitForRuntime: (signal: AbortSignal) => Promise<boolean>,
): Promise<boolean> {
  const abort = new AbortController();
  try {
    const readiness = waitForRuntime(abort.signal);
    // Runtime registration follows verified setup and ownership registration.
    // The session lifetime remains pending while its event iterator is open.
    return await (lifetime
      ? Promise.race([
          readiness,
          lifetime.then(
            () => false,
            () => false,
          ),
        ])
      : readiness);
  } finally {
    abort.abort();
  }
}

export class CapacityAdmissionTimeoutError extends Error {
  constructor() {
    super('Capacity recovery admission timed out; try again explicitly.');
  }
}
export function assertCapacityAdmissionDeadline(deadline?: number) {
  if (deadline !== undefined && Date.now() >= deadline) throw new CapacityAdmissionTimeoutError();
}

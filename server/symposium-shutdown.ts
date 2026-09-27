/** One-shot shutdown. A timeout is uncertainty, never successful cleanup. Stores
 * remain open on failure so late exact cleanup can persist before process exit. */
export function createSymposiumShutdown(
  deps: {
    fence(): void;
    drain(signal: AbortSignal): Promise<void>;
    close(signal: AbortSignal): Promise<void>;
    uncertain(): void;
  },
  timeoutMs = 30_000,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    deps.fence();
    const work = (async () => {
      await deps.drain(controller.signal);
      controller.signal.throwIfAborted();
      await deps.close(controller.signal);
      controller.signal.throwIfAborted();
    })();
    pending = Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error('Symposium shutdown incomplete'));
          reject(controller.signal.reason);
        }, timeoutMs);
      }),
    ])
      .catch((error) => {
        controller.abort(error);
        deps.uncertain();
        throw error;
      })
      .finally(() => clearTimeout(timer));
    return pending;
  };
}

/** Independent exact cleanup must settle before a sibling failure is reported. */
export async function settleSymposiumCleanup(
  operations: readonly (Promise<unknown> | undefined)[],
): Promise<void> {
  const results = await Promise.allSettled(operations);
  if (results.some((result) => result.status === 'rejected'))
    throw new Error('Symposium cleanup incomplete');
}

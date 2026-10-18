/** Prepare format conversions ahead of sends; never grant a command a knowledge selection. */
export function startKnowledgePrewarming(
  store: { prewarm?(signal: AbortSignal): Promise<unknown> } | undefined,
  options: { intervalMs?: number; onError(error: unknown): void },
) {
  if (!store?.prewarm) return undefined;
  const abort = new AbortController();
  let pending: Promise<void> | undefined;
  const refresh = () => {
    if (abort.signal.aborted || pending) return;
    pending = (async () => {
      try {
        await store.prewarm!(abort.signal);
      } catch (error) {
        if (!abort.signal.aborted) options.onError(error);
      }
    })().finally(() => {
      pending = undefined;
    });
  };
  refresh();
  const timer = setInterval(refresh, options.intervalMs ?? 30_000);
  timer.unref();
  return {
    async close() {
      clearInterval(timer);
      abort.abort();
      await pending;
    },
  };
}

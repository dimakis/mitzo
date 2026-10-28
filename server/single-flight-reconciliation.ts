/** Timer ticks are hints to recover durable work, not queued recovery jobs.
 * Keep the reservation until settlement even when an operation times out. */
export function singleFlightReconciliation(
  reconcile: () => Promise<unknown>,
  onError: (error: unknown) => void,
): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    try {
      void reconcile().then(
        () => {
          pending = false;
        },
        (error: unknown) => {
          pending = false;
          onError(error);
        },
      );
    } catch (error) {
      pending = false;
      onError(error);
    }
  };
}

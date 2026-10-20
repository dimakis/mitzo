interface PriorityFeedback {
  saving: boolean;
  error: string | null;
}

/** Owned by the item route so replacing a legacy header with a canonical
 * workspace cannot discard an in-flight write or its uncertainty warning. */
export function createTodoPrioritySaveState(itemId?: string) {
  let feedback: PriorityFeedback = { saving: false, error: null };
  const listeners = new Set<() => void>();
  function publish(next: PriorityFeedback) {
    feedback = next;
    for (const listener of listeners) listener();
  }
  return {
    itemId,
    getSnapshot: () => feedback,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async save(change: () => Promise<void>) {
      if (feedback.saving) return;
      publish({ saving: true, error: null });
      let error: string | null = null;
      try {
        await change();
      } catch {
        error = 'Couldn’t confirm this priority. Refresh to check its status.';
      } finally {
        publish({ saving: false, error });
      }
    },
  };
}
export type TodoPrioritySaveState = ReturnType<typeof createTodoPrioritySaveState>;

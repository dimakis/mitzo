/** Share the successful host owner, but never retain a failed initialization. */
export function createKnowledgeLibraryLoader<T>(initialize: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= Promise.resolve()
      .then(initialize)
      .catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    return pending;
  };
}

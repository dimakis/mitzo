/** Payload-free invalidation after a personal-account mutation or recovered mutation receipt. */
const listeners = new Set<() => void>();
export function invalidateSymposiumAccountCatalog(): void {
  for (const listener of [...listeners]) listener();
}
export function subscribeSymposiumAccountCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface ConfirmedTelosSourceSave {
  conversationId: string;
  itemId: string;
}
const listeners = new Set<(save: Readonly<ConfirmedTelosSourceSave>) => void>();
/** An acknowledged source save invalidates navigation reads. Its payload grants
 * no access and cannot supply a creation card without fresh canonical proof. */
export function subscribeTelosSourceSaves(
  listener: (save: Readonly<ConfirmedTelosSourceSave>) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function announceTelosSourceSaved(save: ConfirmedTelosSourceSave) {
  const confirmed = Object.freeze({ ...save });
  for (const listener of [...listeners]) {
    try {
      listener(confirmed);
    } catch {
      console.error('Unable to refresh confirmed Telos source navigation');
    }
  }
}

/** The legacy workflow spawn callback has no account, model or target authority.
 * Reject before allocating a client/workspace or starting a provider. Explicit
 * Telos worker commands and the pinned conversation retain their existing owners.
 */
export async function rejectUnselectedHeadlessSession(): Promise<never> {
  throw Error(
    'Headless task requires an explicit account, model and execution target. Use an explicitly selected Telos worker or the pinned conversation.',
  );
}

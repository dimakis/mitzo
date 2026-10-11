import { SHUTDOWN_GRACE_MS } from './constants.js';

/** The managed app's original parent already waits for its exit. Giving that
 * child the standalone app's five-second linger races the parent's five-second
 * deadline. Finish teardown first, then let the original parent observe exit.
 * This does not acknowledge or retire any native resource. */
export async function finishAppShutdown(
  custodianController: boolean,
  cleanup: () => Promise<void>,
  exit: () => void,
): Promise<void> {
  await cleanup();
  setTimeout(exit, custodianController ? 0 : SHUTDOWN_GRACE_MS);
}

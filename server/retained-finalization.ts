import { createLogger } from './logger.js';

const log = createLogger('retained-finalization');

/** Join every original finalizer, preserving the action's rejection as primary.
 * Causes stay internal; diagnostics contain only a fixed stage and counts.
 */
export async function joinRetainedFinalizers(
  stage: 'sandbox_command' | 'repository_publication' | 'repository_read' | 'repository_index',
  finalizers: readonly (() => Promise<void>)[],
  failure?: { cause: unknown },
): Promise<void> {
  const secondary: unknown[] = [];
  for (const finalize of finalizers) {
    try {
      await finalize();
    } catch (cause) {
      secondary.push(cause);
    }
  }
  if (secondary.length) {
    log.warn('Operation finalization failed', {
      code: 'operation_finalization_failed',
      stage,
      operationFailed: failure !== undefined,
      failureCount: secondary.length,
    });
    // Repeated rejection with the identical revocation/cancellation object
    // adds no new cause and must retain that original identity.
    if (failure && secondary.every((cause) => cause === failure.cause)) throw failure.cause;
    const primary = failure ? failure.cause : secondary[0];
    throw Object.assign(
      new AggregateError(
        [...(failure ? [failure.cause] : []), ...secondary],
        failure && primary instanceof Error ? primary.message : 'Operation finalization failed',
        { cause: primary },
      ),
      { code: 'operation_finalization_failed', stage },
    );
  }
}

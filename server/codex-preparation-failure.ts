import { CodexStartupError } from './codex-startup-error.js';
import { findSessionRuntimeError, SessionRuntimeError } from './session-runtime-error.js';
import { TelosExecutionContextChangedError } from './telos-work-store.js';

/** Keep the first typed diagnostic and original cause across admission layers.
 * Public responses must still use the reviewed runtime message contract. */
export function retainCodexPreparationFailure(
  phase: ConstructorParameters<typeof CodexStartupError>[0],
  error: unknown,
): Error {
  const retained = findSessionRuntimeError(error);
  if (retained) return retained;
  const seen = new Set<Error>();
  for (
    let cause = error;
    cause instanceof Error && seen.size < 16 && !seen.has(cause);
    cause = cause.cause
  ) {
    seen.add(cause);
    if (cause instanceof TelosExecutionContextChangedError)
      return new SessionRuntimeError('telos_work_context_changed', { cause: error });
  }
  return error instanceof CodexStartupError ? error : new CodexStartupError(phase, error);
}

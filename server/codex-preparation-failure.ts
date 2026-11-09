import { CodexStartupError } from './codex-startup-error.js';
import { findSessionRuntimeError } from './session-runtime-error.js';

/** Keep the first typed diagnostic and original cause across admission layers.
 * Public responses must still use the reviewed runtime message contract. */
export function retainCodexPreparationFailure(
  phase: ConstructorParameters<typeof CodexStartupError>[0],
  error: unknown,
): Error {
  return (
    findSessionRuntimeError(error) ??
    (error instanceof CodexStartupError ? error : new CodexStartupError(phase, error))
  );
}

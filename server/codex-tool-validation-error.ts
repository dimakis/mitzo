import {
  CodexToolFailureDiagnosticSchema,
  codexToolFailureResult,
  type CodexToolFailureDiagnostic,
} from './codex-tool-failure.js';
import { SessionRuntimeError, findSessionRuntimeError } from './session-runtime-error.js';
import { createLogger } from './logger.js';

const log = createLogger('codex-credential-validation');

export type CodexToolValidationStage =
  'runtime_fence' | 'credential_refresh' | 'workspace_check' | 'credential_check';

/** Validation must report its original failure before closing physical custody.
 * The cause stays private; only the shared reviewed reason reaches consumers. */
export class CodexToolValidationError extends SessionRuntimeError {
  readonly reason: CodexToolFailureDiagnostic['reason'];
  constructor(
    readonly stage: CodexToolValidationStage,
    cause: unknown,
    cancelled: boolean,
  ) {
    super('tool_validation_failed', { cause });
    const result = codexToolFailureResult(cause, cancelled);
    this.reason = CodexToolFailureDiagnosticSchema.parse(
      JSON.parse(result.content).diagnostic,
    ).reason;
  }
  validationTelemetry() {
    return {
      runtimeValidationStage: this.stage,
      runtimeValidationReason: this.reason,
    };
  }
}

/** Credential owners must publish before physical close can reenter lifecycle.
 * Startup failures keep their existing classification; live guards add the
 * reviewed validation classification without exposing the private cause. */
export function reportCodexCredentialInvalidation(
  error: unknown,
  validation: boolean,
  cancelled: boolean,
  publish?: (error: SessionRuntimeError) => void,
  isValidationLive: () => boolean = () => true,
): unknown {
  let reviewed = findSessionRuntimeError(error);
  if (!reviewed && validation) {
    try {
      if (isValidationLive() === true)
        reviewed = new CodexToolValidationError('credential_check', error, cancelled);
    } catch {
      log.warn('Credential validation phase unavailable; preserving original failure', {
        stage: 'credential_check',
        code: 'validation_phase_unavailable',
      });
    }
  }
  if (reviewed) {
    try {
      publish?.(reviewed);
    } catch {
      log.warn('Credential validation diagnostic delivery failed', reviewed.telemetry());
    }
  }
  return reviewed ?? error;
}

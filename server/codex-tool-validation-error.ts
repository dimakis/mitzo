import {
  CodexToolFailureDiagnosticSchema,
  codexToolFailureResult,
  type CodexToolFailureDiagnostic,
} from './codex-tool-failure.js';
import { SessionRuntimeError } from './session-runtime-error.js';

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

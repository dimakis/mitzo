import { SessionRuntimeError, findSessionRuntimeError } from './session-runtime-error.js';
import { CodexTransportError } from './codex-app-server-client.js';
import { retainRuntimeFailure, runtimeFailureDiagnostics } from './runtime-failure-diagnostics.js';

type Stage =
  | 'notification'
  | 'host_tool_admission'
  | 'host_tool_execution'
  | 'host_tool_response'
  | 'transport'
  | 'attachment';

/** Keep an untyped native boundary failure correlated through physical close.
 * This is diagnostic identity only: it grants no retry or settlement authority.
 */
class CodexLifecycleFailure extends SessionRuntimeError {
  constructor(
    readonly stage: Stage,
    cause: unknown,
  ) {
    super('runtime_unavailable', { cause });
    retainRuntimeFailure(this.diagnosticId, cause, () => {});
  }
  override telemetry() {
    return {
      ...super.telemetry(),
      runtimeFailureStage: this.stage,
      ...runtimeFailureDiagnostics(this),
    };
  }
}

export function codexLifecycleFailure(cause: unknown, stage: Stage): Error {
  return (
    findSessionRuntimeError(cause) ??
    (cause instanceof CodexTransportError ? cause : new CodexLifecycleFailure(stage, cause))
  );
}

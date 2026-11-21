import { SessionRuntimeError, findSessionRuntimeError } from './session-runtime-error.js';
import { CodexTransportError } from './codex-app-server-client.js';
import { retainRuntimeFailure, runtimeFailureDiagnostics } from './runtime-failure-diagnostics.js';
import { z } from 'zod';

export const CodexLifecycleDiagnosticSchema = z.strictObject({
  diagnosticId: z.uuid(),
  stage: z.enum([
    'notification',
    'host_tool_admission',
    'host_tool_execution',
    'host_tool_response',
    'transport',
    'attachment',
  ]),
  causeType: z.enum(['unknown', 'Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError']),
  causeCode: z
    .enum(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EIO', 'ETIMEDOUT'])
    .optional(),
});
type Stage = z.infer<typeof CodexLifecycleDiagnosticSchema>['stage'];

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

/** Only host-issued lifecycle failures may add durable diagnostic metadata. */
export function codexLifecycleDiagnostic(error: unknown) {
  const failure = findSessionRuntimeError(error);
  if (!(failure instanceof CodexLifecycleFailure)) return undefined;
  const cause = runtimeFailureDiagnostics(failure);
  return CodexLifecycleDiagnosticSchema.parse({
    diagnosticId: failure.diagnosticId,
    stage: failure.stage,
    causeType: cause.causeType,
    ...(cause.causeCode ? { causeCode: cause.causeCode } : {}),
  });
}

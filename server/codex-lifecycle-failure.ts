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

// Lifecycle references for transport errors that keep their own classification.
// Not a cause link: findSessionRuntimeError walks causes and would reclassify.
const transportLifecycleReferences = new WeakMap<CodexTransportError, CodexLifecycleFailure>();

/** Wrap an unexpected boundary failure. Callers create it only for the first
 * close, so a no-op close cannot evict a retained cause. An unexpected
 * notification-handler failure keeps the reviewed `notification_handler_failed`
 * transport classification and message, and carries the lifecycle reference. */
export function codexLifecycleFailure(cause: unknown, stage: Stage): Error {
  const known =
    findSessionRuntimeError(cause) ?? (cause instanceof CodexTransportError ? cause : undefined);
  if (known) return known;
  const failure = new CodexLifecycleFailure(stage, cause);
  if (stage !== 'notification') return failure;
  const transport = new CodexTransportError('connection', {
    reason: 'notification_handler_failed',
  });
  transportLifecycleReferences.set(transport, failure);
  return transport;
}

/** Only host-issued lifecycle failures may add durable diagnostic metadata. */
export function codexLifecycleDiagnostic(error: unknown) {
  const failure =
    (error instanceof CodexTransportError ? transportLifecycleReferences.get(error) : undefined) ??
    findSessionRuntimeError(error);
  if (!(failure instanceof CodexLifecycleFailure)) return undefined;
  const cause = runtimeFailureDiagnostics(failure);
  return CodexLifecycleDiagnosticSchema.parse({
    diagnosticId: failure.diagnosticId,
    stage: failure.stage,
    causeType: cause.causeType,
    ...(cause.causeCode ? { causeCode: cause.causeCode } : {}),
  });
}

import { OperatorAuthorizationError } from './agent-library-transport.js';
import { UnsettledTaskExecutionError } from './task-execution-store.js';
import { toolFailure, toolFailureAction, type ToolFailure } from '@mitzo/protocol';
import { z } from 'zod';

export class TaskExecutionRefusal extends Error {
  constructor(
    readonly code: ToolFailure['code'],
    readonly phase: ToolFailure['phase'],
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Refusal before dispatch is different from losing a command's outcome. */
export function taskExecutionFailure(
  cause: unknown,
  operation: string | undefined,
  requestId: string | undefined,
  effectMayHaveStarted: boolean,
  cancelled = false,
) {
  const authenticationRequired = cause instanceof OperatorAuthorizationError;
  const outcomeUnknown = effectMayHaveStarted || cause instanceof UnsettledTaskExecutionError;
  const failure = toolFailure(
    cancelled
      ? 'cancelled'
      : authenticationRequired
        ? 'operator_authentication_required'
        : cause instanceof TaskExecutionRefusal
          ? cause.code
          : cause instanceof z.ZodError
            ? 'invalid_input'
            : 'internal_failure',
    cause instanceof TaskExecutionRefusal
      ? cause.phase
      : effectMayHaveStarted
        ? 'execution'
        : 'admission',
    outcomeUnknown ? 'unknown' : 'not_started',
  );
  const reconcile =
    operation === 'authorize' || operation === 'revoke'
      ? 'Inspect task authorization status before retrying. Reuse the original requestId when present.'
      : 'Inspect TaskExecution status with the original grantId/requestId and the existing workspace before retrying. Reuse the original requestId; do not repeat the command with a new ID.';
  return {
    failure,
    code: authenticationRequired ? 'operator_authentication_required' : 'task_execution_failed',
    error: authenticationRequired
      ? "TaskExecution cannot access this chat's authenticated operator connection. The connection is unavailable, or the login expired or was revoked."
      : cause instanceof Error
        ? cause.message
        : 'Task execution failed with a non-Error cause',
    operation,
    requestId,
    effectStatus: failure.effectStatus,
    recovery:
      failure.recovery === 'none' || failure.recovery === 'correct_input'
        ? toolFailureAction(failure)
        : authenticationRequired
          ? toolFailureAction(failure) + (outcomeUnknown ? ' ' + reconcile : '')
          : outcomeUnknown
            ? reconcile
            : 'This call was refused before execution. Resolve the reported problem before retrying.',
  };
}

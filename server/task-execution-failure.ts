import { OperatorAuthorizationError } from './agent-library-transport.js';

/** Refusal before dispatch is different from losing a command's outcome. */
export function taskExecutionFailure(
  cause: unknown,
  operation: string | undefined,
  requestId: string | undefined,
  effectMayHaveStarted: boolean,
) {
  const authenticationRequired = cause instanceof OperatorAuthorizationError;
  const reconnect =
    'Reconnect this chat in Mitzo; sign in again if prompted. Restore the authenticated connection before retrying.';
  const reconcile =
    operation === 'authorize' || operation === 'revoke'
      ? 'Inspect task authorization status before retrying. Reuse the original requestId when present.'
      : 'Inspect TaskExecution status with the original grantId/requestId and the existing workspace before retrying. Reuse the original requestId; do not repeat the command with a new ID.';
  return {
    code: authenticationRequired ? 'operator_authentication_required' : 'task_execution_failed',
    error: authenticationRequired
      ? "TaskExecution cannot access this chat's authenticated operator connection. The connection is unavailable, or the login expired or was revoked."
      : cause instanceof Error
        ? cause.message
        : 'Task execution failed with a non-Error cause',
    operation,
    requestId,
    effectStatus: effectMayHaveStarted ? 'unknown' : 'not_started',
    recovery: authenticationRequired
      ? reconnect + (effectMayHaveStarted ? ' After reconnecting: ' + reconcile : '')
      : effectMayHaveStarted
        ? reconcile
        : 'This call was refused before execution. Resolve the reported problem before retrying.',
  };
}

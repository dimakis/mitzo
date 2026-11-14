import { z } from 'zod';

export const APPROVAL_TIMEOUT_MESSAGE =
  'Approval timed out because no response arrived in time. The operation did not run. The conversation can continue. Wait for the user to return, then request fresh approval for the same operation; do not repeat approval requests automatically.';

/** Shared public outcome. It describes a failure; it never grants retry authority. */
export const ToolFailureSchema = z.strictObject({
  code: z.enum([
    'cancelled',
    'approval_unavailable',
    'approval_expired',
    'permission_denied',
    'operator_authentication_required',
    'stale_owner',
    'invalid_input',
    'resource_exhausted',
    'internal_failure',
    'tool_timeout',
  ]),
  phase: z.enum(['admission', 'approval', 'execution', 'cleanup', 'delivery']),
  effectStatus: z.enum(['not_started', 'completed', 'unknown']),
  recovery: z.enum([
    'none',
    'reconnect',
    'renew_approval',
    'correct_input',
    'inspect_operation',
    'repair',
  ]),
});
export type ToolFailure = z.infer<typeof ToolFailureSchema>;

export function toolFailure(
  code: ToolFailure['code'],
  phase: ToolFailure['phase'],
  effectStatus: ToolFailure['effectStatus'],
): ToolFailure {
  const recovery: ToolFailure['recovery'] =
    code === 'cancelled' || code === 'permission_denied'
      ? 'none'
      : code === 'operator_authentication_required'
        ? 'reconnect'
        : effectStatus === 'unknown'
          ? 'inspect_operation'
          : code === 'approval_expired'
            ? 'renew_approval'
            : code === 'invalid_input'
              ? 'correct_input'
              : 'repair';
  return Object.freeze(ToolFailureSchema.parse({ code, phase, effectStatus, recovery }));
}

export function toolFailureAction(failure: ToolFailure): string {
  const inspect =
    'Inspect the original operation receipt and current state before retrying; do not repeat an uncertain effect.';
  if (failure.code === 'operator_authentication_required')
    return (
      'Reconnect this chat in Mitzo; sign in again if prompted.' +
      (failure.effectStatus === 'unknown'
        ? ` After reconnecting: ${inspect}`
        : ' The operation did not start.')
    );
  if (failure.code === 'cancelled')
    return (
      'The operation was cancelled. Resume only when the user asks to continue.' +
      (failure.effectStatus === 'unknown' ? ` ${inspect}` : '')
    );
  if (failure.code === 'permission_denied')
    return (
      'Permission was denied. Do not retry or request another approval unless the user changes that decision.' +
      (failure.effectStatus === 'unknown' ? ` ${inspect}` : '')
    );
  if (failure.effectStatus === 'unknown') return inspect;
  if (failure.code === 'approval_expired') return APPROVAL_TIMEOUT_MESSAGE;
  if (failure.code === 'invalid_input') return 'Correct the tool arguments before another call.';
  return 'The tool failed. Resolve the reported prerequisite before retrying the original operation.';
}

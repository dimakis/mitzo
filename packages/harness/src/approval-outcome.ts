import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { toolFailure, type ToolFailure } from '@mitzo/protocol';

export const PERMISSION_EXPIRED_MESSAGE =
  'Approval timed out because no response arrived in time. The approved operation did not start. This is not a rejection or a broken session. Wait for the user to return, then request fresh approval for the same operation; do not automatically repeat approval requests.';

export type ApprovalPermissionResult = PermissionResult & { failure?: ToolFailure };

export function expiredApprovalResult(): ApprovalPermissionResult {
  return {
    behavior: 'deny',
    message: PERMISSION_EXPIRED_MESSAGE,
    failure: toolFailure('approval_expired', 'approval', 'not_started'),
  };
}

/** SDK adapters can return the denial; operation adapters can throw the same
 * typed outcome instead of losing expiry in a generic authorization error. */
export class ApprovalExpiredError extends Error {
  readonly code = 'approval_expired';
  readonly failure = toolFailure('approval_expired', 'approval', 'not_started');
  constructor() {
    super(PERMISSION_EXPIRED_MESSAGE);
    this.name = 'ApprovalExpiredError';
  }
}

export function throwIfApprovalExpired(result: ApprovalPermissionResult): void {
  if (result.behavior === 'deny' && result.failure?.code === 'approval_expired')
    throw new ApprovalExpiredError();
}

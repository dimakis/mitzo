import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import {
  toolFailure,
  toolFailureAction,
  APPROVAL_TIMEOUT_MESSAGE,
  type ToolFailure,
} from '@mitzo/protocol';

export const PERMISSION_EXPIRED_MESSAGE = APPROVAL_TIMEOUT_MESSAGE;

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
  constructor(options?: ErrorOptions) {
    super(PERMISSION_EXPIRED_MESSAGE, options);
    this.name = 'ApprovalExpiredError';
  }
}

export function throwIfApprovalExpired(result: ApprovalPermissionResult): void {
  if (result.behavior === 'deny' && result.failure?.code === 'approval_expired')
    throw new ApprovalExpiredError();
}

/** Preserve structured refusal in tool protocols whose content field is text. */
export function permissionRefusalContent(result: ApprovalPermissionResult): string {
  if (result.behavior !== 'deny') throw Error('Expected a permission refusal');
  return result.failure
    ? JSON.stringify({
        message: result.message,
        failure: result.failure,
        action: toolFailureAction(result.failure),
      })
    : result.message;
}

export function expiredApprovalToolResult(
  error: unknown,
): { content: string; isError: true } | undefined {
  return error instanceof ApprovalExpiredError
    ? { content: permissionRefusalContent(expiredApprovalResult()), isError: true }
    : undefined;
}

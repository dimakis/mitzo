import type { PermissionRequest } from '@mitzo/protocol';
import { permissionNotificationCategory } from './notification-actions.js';

export const nativeApprovalActions = [
  'ALLOW_ONCE_ACTION',
  'ALLOW_SESSION_ACTION',
  'ALLOW_CONVERSATION_ACTION',
  'ALLOW_SEARCH_SESSION_ACTION',
  'DENY_PERMISSION_ACTION',
] as const;

/** Recheck the displayed scope against the LIVE pending owner at settlement. */
export function validNativeNotificationAction(
  request: PermissionRequest | undefined,
  action: string,
  decision: 'once' | 'always' | 'deny',
  reviewed: { toolName: string; toolInput: string; sessionGrantDescription?: string },
): boolean {
  if (
    !request ||
    reviewed.toolName !== request.toolName ||
    reviewed.toolInput !== request.toolInput
  )
    return false;
  const category = permissionNotificationCategory(request, true);
  if (category === 'SESSION_PERMISSION') return false;
  if (action === 'DENY_PERMISSION_ACTION') return decision === 'deny';
  if (action === 'ALLOW_ONCE_ACTION')
    return decision === 'once' && category !== 'SESSION_CONVERSATION_APPROVAL';
  if (
    decision !== 'always' ||
    request.allowSessionGrant === false ||
    reviewed.sessionGrantDescription !== request.sessionGrantDescription
  )
    return false;
  return (
    (action === 'ALLOW_CONVERSATION_ACTION' && category === 'SESSION_CONVERSATION_APPROVAL') ||
    (action === 'ALLOW_SEARCH_SESSION_ACTION' && category === 'SESSION_SEARCH_PERMISSION') ||
    (action === 'ALLOW_SESSION_ACTION' && category === 'SESSION_APPROVAL')
  );
}

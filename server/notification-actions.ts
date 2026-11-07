import type { PermissionRequest } from '@mitzo/protocol';
import { isCompletePendingToolInput } from './permissions.js';

export function isSessionSearchApproval(request?: PermissionRequest): boolean {
  if (
    request?.toolName !== 'RequestWebAccess' ||
    request.approvalScope !== 'session' ||
    request.questions
  )
    return false;
  try {
    return JSON.parse(request.toolInput).operation === 'search';
  } catch {
    return false;
  }
}
export function permissionNotificationCategory(
  request?: PermissionRequest,
  previews = false,
): string {
  if (
    !previews ||
    !request ||
    request.questions ||
    request.reviewKind ||
    Buffer.byteLength(request.toolInput, 'utf8') > 768
  )
    return 'SESSION_PERMISSION';
  // Completeness belongs to the pending owner, not a tool-name allow list.
  // Summaries and specialized source reviews still open the full Watch review.
  if (!isCompletePendingToolInput(request)) return 'SESSION_PERMISSION';
  if (request.approvalScope === 'conversation') return 'SESSION_CONVERSATION_APPROVAL';
  if (request.allowSessionGrant === false) return 'SESSION_APPROVAL_ONCE';
  return isSessionSearchApproval(request) ? 'SESSION_SEARCH_PERMISSION' : 'SESSION_APPROVAL';
}

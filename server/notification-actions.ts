import type { PermissionRequest } from '@mitzo/protocol';

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
export function permissionNotificationCategory(request?: PermissionRequest): string {
  if (!request || request.questions || request.approvalScope === 'conversation')
    return 'SESSION_PERMISSION';
  return isSessionSearchApproval(request) ? 'SESSION_SEARCH_PERMISSION' : 'SESSION_APPROVAL';
}

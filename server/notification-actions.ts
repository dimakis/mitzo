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
export function permissionNotificationCategory(
  request?: PermissionRequest,
  previews = false,
): string {
  if (
    !previews ||
    !request ||
    request.questions ||
    request.approvalScope === 'conversation' ||
    Buffer.byteLength(request.toolInput, 'utf8') > 768
  )
    return 'SESSION_PERMISSION';
  // Only inputs whose complete execution parameters are present in the card
  // can be displayed and approved in a bounded notification. Summary-only
  // document writes and arbitrary integration grants require the full review UI.
  // Bash cards carry the exact raw command, not a JSON input object.
  if (request.toolName === 'Bash')
    return request.toolInput.trim() ? 'SESSION_APPROVAL' : 'SESSION_PERMISSION';
  try {
    const input = JSON.parse(request.toolInput);
    if (!(
      request.toolName === 'RequestWebAccess' &&
      ['search', 'fetch', 'request_access'].includes(input.operation)
    ))
      return 'SESSION_PERMISSION';
  } catch {
    return 'SESSION_PERMISSION';
  }
  return isSessionSearchApproval(request) ? 'SESSION_SEARCH_PERMISSION' : 'SESSION_APPROVAL';
}

import { afterEach, expect, it, vi } from 'vitest';
import { registerPending, removePending } from '../permissions.js';
import { permissionNotificationCategory } from '../notification-actions.js';
import type { PermissionRequest } from '@mitzo/protocol';

afterEach(() => removePending('watch-all'));

it.each([
  'NativeCommandApproval',
  'NativeFileApproval',
  'NativePermissionsApproval',
  'TaskExecution',
  'ConnectionRequest',
  'GitHubRead',
  'GoogleWorkspaceRead',
  'RequestGithubPublish',
  'CustomGrant',
])('offers notification approval for complete %s requests', (toolName) => {
  const input = { operation: 'reviewed-operation', target: '/workspace', network: false };
  const request: PermissionRequest = {
    permId: 'watch-all',
    sessionId: 's1',
    toolName,
    toolInput: JSON.stringify(input),
    allowSessionGrant: false,
  };
  registerPending(request.permId, toolName, vi.fn(), input, 'elevated', 's1', request);
  expect(permissionNotificationCategory(request, true)).toBe('SESSION_APPROVAL_ONCE');
});

it('keeps session and conversation grants distinct from one-shot approvals', () => {
  const input = { connectionId: 'ha', methods: ['GET'] };
  const request: PermissionRequest = {
    permId: 'watch-all',
    sessionId: 's1',
    toolName: 'ConnectionRequest',
    toolInput: JSON.stringify(input),
    approvalScope: 'conversation',
  };
  registerPending(request.permId, request.toolName, vi.fn(), input, 'elevated', 's1', request);
  expect(permissionNotificationCategory(request, true)).toBe('SESSION_CONVERSATION_APPROVAL');
  expect(permissionNotificationCategory({ ...request, approvalScope: 'session' }, true)).toBe(
    'SESSION_APPROVAL',
  );
});

it('never adds banner approval to a summary of different execution parameters', () => {
  const request: PermissionRequest = {
    permId: 'watch-all',
    sessionId: 's1',
    toolName: 'Write',
    toolInput: JSON.stringify({ path: '/workspace/file', contentPreview: 'partial' }),
  };
  registerPending(
    request.permId,
    request.toolName,
    vi.fn(),
    { path: '/workspace/file', content: 'full content' },
    'elevated',
    's1',
    request,
  );
  expect(permissionNotificationCategory(request, true)).toBe('SESSION_PERMISSION');
});

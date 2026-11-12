// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApprovalRequestSummary } from '../ApprovalRequestSummary';
import { PermissionBanner } from '../PermissionBanner';
import { NativeApprovalRequestSchema } from '../../../../server/codex-native-permission-protocol';

afterEach(cleanup);
const identity = { threadId: 'thread', turnId: 'turn', itemId: 'item', startedAtMs: 1794300000000 };
it.each([
  {
    tool: 'NativeCommandApproval',
    method: 'item/commandExecution/requestApproval',
    params: {
      ...identity,
      kind: 'command',
      environmentId: 'local',
      command: 'gh pr view 42',
      cwd: '/repo',
    },
    fact: 'gh pr view 42',
  },
  {
    tool: 'NativeFileApproval',
    method: 'item/fileChange/requestApproval',
    params: { ...identity, grantRoot: '/repo' },
    fact: '/repo',
  },
  {
    tool: 'NativePermissionsApproval',
    method: 'item/permissions/requestApproval',
    params: {
      ...identity,
      environmentId: 'local',
      cwd: '/repo',
      reason: null,
      permissions: { network: { enabled: true }, fileSystem: null },
    },
    fact: 'Enabled for this request',
  },
])(
  'summarizes the real $tool envelope while preserving its approval callback identity',
  ({ tool, method, params, fact }) => {
    const request = NativeApprovalRequestSchema.parse({ method, id: 206, params });
    const input = JSON.stringify({
      runtimeId: 'runtime',
      environmentId: 'local',
      subagent: 'worker',
      requestId: request.id,
      method: request.method,
      params: request.params,
    });
    const respond = vi.fn();
    render(
      <PermissionBanner
        permId="approval-206"
        toolName={tool}
        toolInput={input}
        onRespond={respond}
        allowSessionGrant={false}
      />,
    );
    expect(screen.getByText(fact)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Request details' }).getAttribute('aria-expanded'),
    ).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Approve once' }));
    expect(respond).toHaveBeenCalledWith('approval-206', 'once', tool);
  },
);

it.each([
  { cwd: '/repo', operation: 'delete', resource: '/repo/data', scope: 'all' },
  { command: 'delete all records', cwd: '/repo' },
  { method: 'item/commandExecution/requestApproval', params: { command: 'delete all records' } },
])('keeps unfamiliar tool schemas open even when they reuse known field names: %j', (request) => {
  const input = JSON.stringify(request);
  render(<ApprovalRequestSummary input={input} toolName="mcp__records__mutate" />);
  expect(document.querySelector('.approval-request-details')?.hasAttribute('open')).toBe(true);
  expect(screen.getByText(input)).toBeTruthy();
});
it.each([
  { network: { enabled: true, futurePolicy: 'unrestricted' } },
  { fileSystem: { write: ['/output', { path: '/other' }] } },
  { fileSystem: { entries: [{ path: { type: 'future', path: '/other' }, access: 'write' }] } },
  { fileSystem: { futureScope: '/' } },
  { fileSystem: 'unrestricted' },
])(
  'keeps unknown nested permission scope visible alongside known command facts: %j',
  (permissions) => {
    const input = JSON.stringify({
      method: 'item/commandExecution/requestApproval',
      params: { command: 'gh pr view 42', additionalPermissions: permissions },
    });
    render(<ApprovalRequestSummary input={input} />);
    expect(screen.getByText('gh pr view 42')).toBeTruthy();
    expect(document.querySelector('.approval-request-details')?.hasAttribute('open')).toBe(true);
    expect(screen.getByText(input)).toBeTruthy();
  },
);

it.each([
  { command: 'git status', dangerouslyDisableSandbox: true },
  { command: 'git status', timeout: 600000 },
  { command: 'git status', description: 'Extra operation details' },
  {
    method: 'item/commandExecution/requestApproval',
    params: { command: 'git status', dangerouslyDisableSandbox: true },
  },
  {
    method: 'item/commandExecution/requestApproval',
    params: { command: 'git status' },
    dangerouslyDisableSandbox: true,
  },
])('keeps unpresented top-level and tool fields visible: %j', (request) => {
  const input = JSON.stringify(request);
  render(<ApprovalRequestSummary input={input} toolName="Bash" />);
  expect(document.querySelector('.approval-request-details')?.hasAttribute('open')).toBe(true);
  expect(screen.getByText(input)).toBeTruthy();
});

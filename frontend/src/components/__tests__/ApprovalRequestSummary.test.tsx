// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PermissionBanner } from '../PermissionBanner';
import { ApprovalRequestSummary } from '../ApprovalRequestSummary';
afterEach(cleanup);
it('shows the exact command, directory and broad network access before collapsed technical details', () => {
  const input = JSON.stringify({
    runtimeId: 'internal-runtime',
    method: 'item/commandExecution/requestApproval',
    params: {
      command: 'gh pr view 42',
      cwd: '/repo',
      additionalPermissions: {
        network: { enabled: true },
        fileSystem: { read: ['/source'], write: ['/output'] },
      },
    },
  });
  const respond = vi.fn();
  render(
    <PermissionBanner
      permId="request"
      toolName="CodexNativeCommand"
      title="Run command with network access"
      toolInput={input}
      onRespond={respond}
      allowSessionGrant={false}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Run gh with network access' })).toBeTruthy();
  expect(screen.getByText('gh pr view 42')).toBeTruthy();
  expect(screen.getByText('/repo')).toBeTruthy();
  expect(screen.getByText('Enabled for this request')).toBeTruthy();
  expect(screen.getByText('/output')).toBeTruthy();
  expect(document.querySelector('.approval-request-details')?.hasAttribute('open')).toBe(false);
  expect(screen.queryByRole('button', { name: 'Allow for Session' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
  expect(respond).toHaveBeenCalledWith('request', 'once', 'CodexNativeCommand');
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

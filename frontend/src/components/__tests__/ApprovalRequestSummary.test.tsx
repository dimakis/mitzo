// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PermissionBanner } from '../PermissionBanner';
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
  expect(
    screen.getByRole('button', { name: 'Request details' }).getAttribute('aria-expanded'),
  ).toBe('false');
  expect(screen.queryByRole('button', { name: 'Approve for session' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Approve once' }));
  expect(respond).toHaveBeenCalledWith('request', 'once', 'CodexNativeCommand');
});

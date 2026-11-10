// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ApprovalRequestSummary } from '../ApprovalRequestSummary';

afterEach(cleanup);
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

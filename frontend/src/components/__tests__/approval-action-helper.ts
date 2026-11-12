import { fireEvent, screen, waitFor } from '@testing-library/react';

/** Follow the approved secondary-action menu; missing choices still fail tests. */
export function queryApprovalAction(name: string | RegExp) {
  const primary = screen.queryByRole('button', { name });
  if (primary) return primary;
  if (
    typeof name !== 'string' ||
    ![
      'Approve for session',
      'Approve searches for this session',
      'Deny',
      'Cancel',
      'Dismiss',
      'Request changes',
      'Back to proposal',
    ].includes(name)
  )
    return null;
  const menu = screen.queryByRole('button', { name: 'More approval actions' });
  if (
    menu &&
    !(menu as HTMLButtonElement).disabled &&
    menu.getAttribute('aria-expanded') !== 'true'
  )
    fireEvent.click(menu);
  return screen.queryByRole('menuitem', { name });
}
export function approvalAction(name: string | RegExp) {
  const action = queryApprovalAction(name);
  if (!action) throw new Error(`Approval action unavailable: ${name}`);
  return action;
}
export function findApprovalAction(name: string | RegExp) {
  return waitFor(() => approvalAction(name));
}

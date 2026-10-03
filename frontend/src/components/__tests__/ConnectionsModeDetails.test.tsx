// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { AccessResource } from '../../types/connections-access';
import { ConnectionsModeDetails } from '../ConnectionsModeDetails';

afterEach(cleanup);
const account: AccessResource = {
  id: 'account:work',
  kind: 'ai-account',
  section: 'accounts',
  owner: 'account-profiles',
  nativeId: 'work',
  gateway: null,
  workspace: null,
  label: 'Work API',
  provider: 'openai-codex',
  status: 'ready',
  revision: null,
  accountIdentity: 'Work account',
  verification: { state: 'verified', verifiedAt: 1, reason: null },
  access: {
    summary: 'Configured',
    desiredAccountIds: [],
    observedAttachments: null,
    appliesTo: 'Chats',
  },
  actions: [],
  details: {
    models: [
      { id: 'luna', label: 'Luna' },
      { id: 'sol', label: 'Sol' },
    ],
  },
};
it('inspects each configured model without claiming runtime or mode compatibility from its provider', () => {
  render(<ConnectionsModeDetails resource={account} />);
  expect(screen.getByText(/runtime and mode availability have not been checked/i)).toBeTruthy();
  const selector = screen.getByRole('combobox', { name: 'Configured model' });
  fireEvent.change(selector, { target: { value: 'sol' } });
  fireEvent.click(screen.getByRole('button', { name: /Inspect Ask mode/ }));
  expect(screen.getByRole('heading', { name: 'Ask mode' })).toBeTruthy();
  expect(screen.getByText('Work API · Sol')).toBeTruthy();
  expect(screen.getByText(/Only known read-only tools/)).toBeTruthy();
  expect(screen.getByText(/OpenShell Codex does not support Ask/)).toBeTruthy();
  expect(screen.getByText(/Codex provider search requires consent/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back to modes' }));
  expect((selector as HTMLSelectElement).value).toBe('sol');
});
it('explains elevated and unknown approvals separately in Agent and Auto', () => {
  render(<ConnectionsModeDetails resource={account} />);
  fireEvent.click(screen.getByRole('button', { name: /Inspect Agent mode/ }));
  expect(screen.getByText(/Elevated commands require approval/)).toBeTruthy();
  expect(screen.getByText(/Unknown tools still require approval/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back to modes' }));
  fireEvent.click(screen.getByRole('button', { name: /Inspect Auto mode/ }));
  expect(screen.getByText(/Elevated commands may be automatically allowed/)).toBeTruthy();
  expect(screen.getByText(/Unknown tools still require approval/)).toBeTruthy();
  expect(screen.getByText(/does not expand service permissions/)).toBeTruthy();
});
it('uses paired catalog models and explains an absent catalog without inventing a model', () => {
  const { unmount } = render(
    <ConnectionsModeDetails resource={{ ...account, details: {} }} catalog={account} />,
  );
  expect(screen.getByRole('option', { name: 'Luna' })).toBeTruthy();
  unmount();
  render(<ConnectionsModeDetails resource={{ ...account, details: {} }} />);
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByText('No configured models reported.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Inspect Ask mode/ }));
  expect(screen.getByText('Work API · Model not reported')).toBeTruthy();
});

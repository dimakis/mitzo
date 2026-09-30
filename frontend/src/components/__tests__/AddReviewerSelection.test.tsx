// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { AddReviewerSheet } from '../AddReviewerSheet';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../SymposiumProfilePicker', () => ({
  SymposiumProfilePicker: ({ onChange }: { onChange: (v: unknown) => void }) => (
    <button onClick={() => onChange({ profileId: 'review', revision: 1 })}>Choose profile</button>
  ),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('keeps submission disabled with the real picker until the user confirms account and model', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url) === '/api/symposium/accounts'
            ? [
                {
                  id: 'a',
                  label: 'Personal account',
                  models: [
                    { id: 'luna', label: 'Luna' },
                    { id: 'other', label: 'Other' },
                  ],
                },
              ]
            : {
                config: {
                  version: 2,
                  anchorSeatId: 'anchor',
                  seats: [{ id: 'anchor', accountBinding: { accountId: 'a' } }],
                },
                seats: [],
                runtimeAvailable: true,
              },
        ),
      ),
  );
  render(<AddReviewerSheet sessionId="chat" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  await screen.findByRole('button', { name: 'Use Personal account · Luna' });
  fireEvent.click(screen.getByText('Choose profile'));
  fireEvent.change(screen.getByLabelText('Review package'), {
    target: { value: 'Review this diff' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  const submit = screen.getByRole('button', { name: 'Add reviewer and queue context' });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Use Personal account · Luna' }));
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'other' } });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Use Personal account · Other' }));
  expect(submit).toBeEnabled();
  expect(
    vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
  ).toBe(true);
});

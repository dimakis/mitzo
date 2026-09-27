// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumPersonalLogin } from '../SymposiumPersonalLogin';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('requires an operator-selected displayed slot revision before device login', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async (url, init) =>
      ({
        ok: true,
        json: async () =>
          url.endsWith('/connections')
            ? {
                connections: [
                  { id: 'default', label: 'Personal', revision: 7, state: 'connected' },
                ],
              }
            : init?.method === 'POST'
              ? { state: 'pending', connectionId: 'default', attemptId: 'attempt' }
              : { state: 'idle' },
      }) as Response,
  );
  render(<SymposiumPersonalLogin callback />);
  await screen.findByText('Personal (revision 7)');
  expect(screen.queryByRole('button', { name: 'Connect ChatGPT' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Saved account for sign-in'), {
    target: { value: 'default' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Get sign-in code' }));
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/symposium/personal/login',
      expect.objectContaining({
        body: JSON.stringify({
          method: 'device-code',
          connectionId: 'default',
          expectedRevision: 7,
        }),
      }),
    ),
  );
});

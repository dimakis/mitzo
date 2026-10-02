// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumPersonalLogin } from '../SymposiumPersonalLogin';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
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

it('keeps a callback receipt and completion mounted across changed slot revisions', async () => {
  vi.useFakeTimers();
  let revision = 7;
  let started = false;
  let completed = false;
  vi.mocked(apiFetch).mockImplementation(
    async (url, init) =>
      ({
        ok: true,
        json: async () => {
          if (url.endsWith('/connections'))
            return {
              connections: [
                {
                  id: 'default',
                  label: 'Personal',
                  revision,
                  state: started && !completed ? 'connecting' : 'connected',
                },
              ],
            };
          if (init?.method === 'POST') {
            started = true;
            revision = 8;
            return {
              attemptId: 'callback-1',
              authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=synthetic',
            };
          }
          return started
            ? {
                state: completed ? 'completed' : 'pending',
                connectionId: 'default',
                attemptId: 'callback-1',
              }
            : { state: 'idle' };
        },
      }) as Response,
  );
  render(<SymposiumPersonalLogin callback />);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText('Saved account for sign-in'), {
    target: { value: 'default' },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' })),
  );
  fireEvent.click(screen.getByLabelText('Browser on the Mitzo server'));
  fireEvent.click(screen.getByLabelText('The callback setup is ready on the browser computer'));
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Start personal login' })),
  );
  expect(screen.getByRole('link', { name: 'Open official OpenAI login' })).toBeTruthy();
  expect(screen.getByText('Personal (revision 8)')).toBeTruthy();
  expect((screen.getByLabelText('Saved account for sign-in') as HTMLSelectElement).disabled).toBe(
    true,
  );
  completed = true;
  revision = 9;
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByText(/Login completed. Refreshing account catalog/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved accounts' }));
  await act(async () => {});
  expect(screen.getByText(/Login completed. Refreshing account catalog/)).toBeTruthy();
  expect((screen.getByLabelText('Saved account for sign-in') as HTMLSelectElement).value).toBe('');
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
    1,
  );
  expect(
    (
      screen.getByRole('group', {
        name: 'Where will you open the login browser?',
      }) as HTMLFieldSetElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('Saved account for sign-in'), {
    target: { value: 'default' },
  });
  expect(screen.getByText('Selected for this sign-in: Personal, revision 9.')).toBeTruthy();
  expect(screen.queryByText(/Login completed. Refreshing account catalog/)).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
    1,
  );
});

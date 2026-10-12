// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdatesView } from '../UpdatesView';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function fixture(available: boolean, action = true) {
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes('config')
            ? {
                quickActions: action
                  ? [
                      {
                        label: 'Deploy Mitzo',
                        prompt: 'Review and deploy the accepted update',
                        cwd: '/workspace',
                        extraTools: 'Files',
                      },
                    ]
                  : [],
              }
            : { updateAvailable: available, commit: 'a'.repeat(40), hash: 'build123' },
        ),
        { status: 200 },
      ),
  );
}
it('moves update review to its dedicated settings page and preserves configured action parameters', async () => {
  fixture(true);
  render(
    <MemoryRouter>
      <UpdatesView />
    </MemoryRouter>,
  );
  const review = await screen.findByRole('link', { name: /Review update/ });
  const url = new URL(review.getAttribute('href')!, 'https://mitzo.test');
  expect(url.pathname).toBe('/chat');
  expect(url.searchParams.get('prompt')).toBe('Review and deploy the accepted update');
  expect(url.searchParams.get('cwd')).toBe('/workspace');
  expect(url.searchParams.get('extraTools')).toBe('Files');
  expect(screen.getByText('aaaaaaaa')).toBeTruthy();
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.every(([, options]) => !options?.method || options.method === 'GET'),
  ).toBe(true);
});
it('shows a current release and can explicitly check again', async () => {
  fixture(false);
  render(
    <MemoryRouter>
      <UpdatesView />
    </MemoryRouter>,
  );
  await screen.findByText('You’re up to date');
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/version/check',
      expect.objectContaining({ method: 'POST' }),
    ),
  );
});
it('shows missing deployment configuration and failed checks honestly', async () => {
  fixture(true, false);
  render(
    <MemoryRouter>
      <UpdatesView />
    </MemoryRouter>,
  );
  await screen.findByText(/An update action hasn’t been configured/);
  expect(screen.queryByRole('link', { name: /Review update/ })).toBeNull();
  vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 503 }));
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  await screen.findByRole('alert');
});
it('recovers both version and configured action after an initial configuration failure', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes('config') ? {} : { updateAvailable: true, commit: 'b'.repeat(40) },
        ),
        { status: String(url).includes('config') ? 503 : 200 },
      ),
  );
  render(
    <MemoryRouter>
      <UpdatesView />
    </MemoryRouter>,
  );
  await screen.findByRole('alert');
  fixture(true);
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  await screen.findByRole('link', { name: /Review update/ });
});

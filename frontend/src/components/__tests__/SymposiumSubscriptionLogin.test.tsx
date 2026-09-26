// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumSubscriptionLogin } from '../SymposiumSubscriptionLogin';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

it('requires an explicit ready callback transport and only exposes the official auth URL', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
    init?.method === 'POST'
      ? response({
          attemptId: 'attempt',
          authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=fake',
        })
      : response({ state: 'pending', attemptId: 'attempt' }),
  );
  render(<SymposiumSubscriptionLogin onComplete={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(
    (screen.getByRole('button', { name: 'Start personal login' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByText(/A phone cannot complete/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Browser on another computer with SSH'));
  expect(screen.getByText(/ssh -N -o ExitOnForwardFailure/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText('The callback setup is ready on the browser computer'));
  fireEvent.click(screen.getByRole('button', { name: 'Start personal login' }));
  const link = await screen.findByRole('link', { name: 'Open official OpenAI login' });
  expect(link.getAttribute('href')).toBe('https://auth.openai.com/oauth/authorize?state=fake');
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/symposium/personal/login',
    expect.objectContaining({ body: JSON.stringify({ callbackTransport: 'ssh-forwarded' }) }),
  );
});

it.each([
  'https://evil.example/auth',
  'https://auth.openai.com.evil.example/oauth/authorize',
  'http://auth.openai.com/oauth/authorize',
])('rejects untrusted authorization URL %s', async (authorizationUrl) => {
  vi.mocked(apiFetch).mockResolvedValue(response({ attemptId: 'attempt', authorizationUrl }));
  render(<SymposiumSubscriptionLogin onComplete={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
  fireEvent.click(screen.getByLabelText('Browser on the Mitzo server'));
  fireEvent.click(screen.getByLabelText('The callback setup is ready on the browser computer'));
  fireEvent.click(screen.getByRole('button', { name: 'Start personal login' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('link')).toBeNull();
});

it.each(['completed', 'failed', 'unknown'])(
  'shows definitive %s status without inferring success from accounts',
  async (state) => {
    vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
      init?.method === 'POST'
        ? response({
            attemptId: 'attempt',
            authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=fake',
          })
        : response({ state, ...(state === 'unknown' ? {} : { attemptId: 'attempt' }) }),
    );
    const onComplete = vi.fn();
    render(<SymposiumSubscriptionLogin onComplete={onComplete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
    fireEvent.click(screen.getByLabelText('Browser on the Mitzo server'));
    fireEvent.click(screen.getByLabelText('The callback setup is ready on the browser computer'));
    fireEvent.click(screen.getByRole('button', { name: 'Start personal login' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/symposium/personal/login/status?attemptId=attempt',
        expect.any(Object),
      ),
    );
    if (state === 'completed') {
      await screen.findByText(/Login completed/);
      expect(onComplete).toHaveBeenCalledTimes(1);
    } else {
      await screen.findByRole('alert');
      expect(onComplete).not.toHaveBeenCalled();
    }
  },
);

it('recovers a pending receipt after remount without persisting or exposing an auth URL', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ state: 'pending', attemptId: 'existing' }));
  render(<SymposiumSubscriptionLogin onComplete={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
  await screen.findByText(/Continue in the already-open login browser/);
  expect(screen.queryByRole('link')).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Start personal login' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/symposium/personal/login/status?attemptId=existing',
      expect.any(Object),
    ),
  );
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('does not count a historical completed receipt as completion of a new login', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ state: 'completed', attemptId: 'old' }));
  const onComplete = vi.fn();
  render(<SymposiumSubscriptionLogin onComplete={onComplete} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
  await screen.findByText(/Previous login completed/);
  expect(onComplete).not.toHaveBeenCalled();
});

it('refreshes the catalog for a recovered completed receipt without claiming a new login', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ state: 'completed', attemptId: 'old' }));
  const onComplete = vi.fn();
  const onCatalogRefresh = vi.fn();
  render(
    <SymposiumSubscriptionLogin onComplete={onComplete} onCatalogRefresh={onCatalogRefresh} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
  await screen.findByText(/Previous login completed/);
  expect(onCatalogRefresh).toHaveBeenCalledTimes(1);
  expect(onComplete).not.toHaveBeenCalled();
});

it('retries initial receipt recovery in place and resumes pending polling', async () => {
  vi.mocked(apiFetch)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(response({ state: 'pending', attemptId: 'existing' }));
  render(<SymposiumSubscriptionLogin onComplete={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry status' }));
  await screen.findByText(/Continue in the already-open login browser/);
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/symposium/personal/login/status?attemptId=existing',
      expect.any(Object),
    ),
  );
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

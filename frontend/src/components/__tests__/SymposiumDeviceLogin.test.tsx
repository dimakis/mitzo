// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { copyToClipboard } from '../../lib/clipboard';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumDeviceLogin } from '../SymposiumDeviceLogin';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../../lib/clipboard', () => ({ copyToClipboard: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const pending = {
  attemptId: 'device-1',
  method: 'device-code',
  state: 'pending',
  verificationUrl: 'https://auth.openai.com/codex/device',
  userCode: 'ABCD-EFGH',
  expiresAt: Date.now() + 600000,
};
it('starts only on click and lets a phone open the official device page with a user code', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
    response(init?.method === 'POST' ? pending : { state: 'idle' }),
  );
  render(<SymposiumDeviceLogin />);
  expect(apiFetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' }));
  await screen.findByRole('button', { name: 'Get sign-in code' });
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Get sign-in code' }));
  expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open OpenAI sign-in' }).getAttribute('href')).toBe(
    pending.verificationUrl,
  );
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/symposium/personal/login',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ method: 'device-code' }) }),
  );
});
it('recovers a pending code after refresh without starting another login and cancels explicitly', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      url.endsWith('/cancel') ? { attemptId: pending.attemptId, state: 'cancelled' } : pending,
    ),
  );
  render(<SymposiumDeviceLogin />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' }));
  await screen.findByText(pending.userCode);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  await screen.findByText(/Sign-in cancelled/);
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/symposium/personal/login/cancel',
    expect.objectContaining({ body: JSON.stringify({ attemptId: pending.attemptId }) }),
  );
  expect(screen.queryByText(pending.userCode)).toBeNull();
});
it.each(['expired', 'unknown', 'failed', 'cancelled'])(
  'offers explicit retry for %s',
  async (state) => {
    vi.mocked(apiFetch).mockResolvedValue(response({ state }));
    render(<SymposiumDeviceLogin />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' }));
    expect(await screen.findByRole('button', { name: 'Get sign-in code' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open OpenAI sign-in' })).toBeNull();
  },
);
it('refreshes the account catalog for completed recovery and offers reconnect without rebinding a seat', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ state: 'completed', attemptId: 'done' }));
  const onAccountsChanged = vi.fn();
  render(<SymposiumDeviceLogin onAccountsChanged={onAccountsChanged} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' }));
  await screen.findByRole('button', { name: 'Reconnect ChatGPT' });
  expect(onAccountsChanged).toHaveBeenCalledTimes(1);
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
it('retries status failures in place and clears the recovery error when no attempt remains', async () => {
  vi.mocked(apiFetch)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(response({ state: 'idle' }));
  render(<SymposiumDeviceLogin />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry status' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry status' })).toBeNull());
  expect(
    (screen.getByRole('button', { name: 'Get sign-in code' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});
it('rejects an unofficial device address', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    response({ ...pending, verificationUrl: 'https://auth.openai.com.evil.example/codex/device' }),
  );
  render(<SymposiumDeviceLogin />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('link', { name: 'Open OpenAI sign-in' })).toBeNull();
});

it('keeps quarantined cleanup blocked and offers status recovery only', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ state: 'unknown', retryBlocked: true }));
  render(<SymposiumDeviceLogin />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' }));
  await screen.findByRole('button', { name: 'Retry status' });
  expect(screen.queryByRole('button', { name: 'Get sign-in code' })).toBeNull();
});
it('polls allocating receipts and shows verified identity only after exact completion', async () => {
  vi.useFakeTimers();
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      response({ state: 'pending', attemptId: 'device-1', method: 'device-code' }),
    )
    .mockResolvedValueOnce(response(pending))
    .mockResolvedValueOnce(
      response({
        state: 'completed',
        attemptId: 'device-1',
        account: { label: 'Personal ChatGPT', email: 'operator@example.test', planType: 'plus' },
      }),
    );
  const onAccountsChanged = vi.fn();
  render(<SymposiumDeviceLogin onAccountsChanged={onAccountsChanged} />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' })));
  expect(screen.queryByText(pending.userCode)).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByText(pending.userCode)).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByText('operator@example.test')).toBeTruthy();
  expect(screen.queryByText(pending.userCode)).toBeNull();
  expect(onAccountsChanged).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
  'reports clipboard result %s without changing sign-in state',
  async (copied) => {
    vi.mocked(apiFetch).mockResolvedValue(response(pending));
    vi.mocked(copyToClipboard).mockResolvedValue(copied);
    render(<SymposiumDeviceLogin />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy code' }));
    await screen.findByText(
      copied ? 'Code copied.' : 'Could not copy. Select the code above and copy it manually.',
    );
    expect(copyToClipboard).toHaveBeenCalledWith(pending.userCode);
    expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeTruthy();
  },
);
it('ignores a stale completed response after the control closes', async () => {
  let resolve!: (value: Response) => void;
  vi.mocked(apiFetch)
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue(response({ state: 'idle' }));
  const onAccountsChanged = vi.fn();
  render(<SymposiumDeviceLogin onAccountsChanged={onAccountsChanged} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await act(async () => resolve(response({ state: 'completed', attemptId: 'stale' })));
  expect(onAccountsChanged).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' }));
  expect(await screen.findByRole('button', { name: 'Get sign-in code' })).toBeTruthy();
});

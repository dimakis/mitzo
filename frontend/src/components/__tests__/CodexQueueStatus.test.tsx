// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { CodexQueueStatus } from '../CodexQueueStatus';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});
it('restores paused queue status without replay and requires an explicit continue action', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      codexQueue: { paused: true, connected: true, queued: 2, interrupted: 1 },
    }),
  } as Response);
  render(<CodexQueueStatus sessionId="task" />);
  await screen.findByText(/2 queued messages/);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Inspect interrupted actions/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Continue queued messages' }));
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/task/codex-queue/continue', {
      method: 'POST',
    }),
  );
});
it('hides for other backends and explains a disconnected saved queue', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response);
  const { rerender } = render(<CodexQueueStatus sessionId="vertex" />);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
  expect(screen.queryByRole('status')).toBeNull();
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      codexQueue: { paused: true, connected: false, queued: 1, interrupted: 1 },
    }),
  } as Response);
  rerender(<CodexQueueStatus sessionId="codex" />);
  await screen.findByText(/Send a message to reconnect/);
  expect(screen.queryByRole('button', { name: 'Continue queued messages' })).toBeNull();
});

it('slows idle polling and avoids overlapping requests', async () => {
  vi.useFakeTimers();
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      codexQueue: { paused: false, connected: true, queued: 0, interrupted: 0 },
    }),
  } as Response);
  render(<CodexQueueStatus sessionId="idle" />);
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(apiFetch).toHaveBeenCalledTimes(1);
  vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(apiFetch).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(apiFetch).toHaveBeenCalledTimes(2);
});
it('shows the server recovery explanation when continuation fails', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      codexQueue: { paused: true, connected: true, queued: 1, interrupted: 1 },
    }),
  } as Response);
  render(<CodexQueueStatus sessionId="paused" />);
  const button = await screen.findByRole('button', { name: 'Continue queued messages' });
  vi.mocked(apiFetch).mockResolvedValueOnce({
    ok: false,
    json: async () => ({ error: 'Queue remains paused. Check the account configuration.' }),
  } as Response);
  fireEvent.click(button);
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Queue remains paused. Check the account configuration.',
  );
});

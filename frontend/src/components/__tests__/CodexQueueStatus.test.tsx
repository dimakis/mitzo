// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { CodexQueueStatus } from '../CodexQueueStatus';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
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

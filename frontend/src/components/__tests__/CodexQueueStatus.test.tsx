// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiFetch } from '../../lib/api-fetch';
import { CodexQueueStatus } from '../CodexQueueStatus';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it('explains paused saved work without a second recovery action', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      codexQueue: { paused: true, connected: true, queued: 2, interrupted: 1, recovering: false },
    }),
  } as Response);
  render(<CodexQueueStatus sessionId="task" />);
  await screen.findByText('2 messages waiting');
  expect(screen.getByText(/Your last step may be incomplete/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /continue|reconnect/i })).toBeNull();
  expect(screen.getByRole('button', { name: 'Hide' })).toBeTruthy();
});

it('tells the user to send when no runtime is connected', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      codexQueue: { paused: true, connected: false, queued: 1, interrupted: 1, recovering: false },
    }),
  } as Response);
  render(<CodexQueueStatus sessionId="codex" />);
  await screen.findByText('Connection interrupted. Send a message to reconnect.');
  expect(screen.queryByRole('button', { name: /continue|reconnect/i })).toBeNull();
});

it.each([
  ['starting_workspace', 'Starting workspace…'],
  ['reconnecting', 'Reconnecting…'],
] as const)('shows actual %s recovery progress without an action gate', async (phase, label) => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      codexQueue: {
        paused: true,
        connected: true,
        recovering: true,
        recoveryPhase: phase,
        queued: 1,
        interrupted: 1,
      },
    }),
  } as Response);
  render(<CodexQueueStatus sessionId="recovering" />);
  await screen.findByText(label);
  expect(screen.getByText('Your message is saved.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /continue|reconnect/i })).toBeNull();
});

it('collapses with a horizontal swipe and restores focus through Chat status', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      codexQueue: { paused: true, connected: true, queued: 0, interrupted: 1, recovering: false },
    }),
  } as Response);
  render(<CodexQueueStatus sessionId="paused" />);
  const status = await screen.findByRole('status');
  fireEvent.pointerDown(status, { clientX: 8, clientY: 12 });
  fireEvent.pointerUp(status, { clientX: 72, clientY: 14 });
  const tab = screen.getByRole('button', { name: 'Chat status' });
  expect(document.activeElement).toBe(tab);
  const user = userEvent.setup();
  await user.keyboard('{Enter}');
  const hide = await screen.findByRole('button', { name: 'Hide' });
  await waitFor(() => expect(document.activeElement).toBe(hide));
});

it('reopens a hidden status when polling finds an actionable error', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        codexQueue: { paused: true, connected: true, queued: 0, interrupted: 1, recovering: false },
      }),
    } as Response)
    .mockRejectedValueOnce(new Error('offline'));
  render(<CodexQueueStatus sessionId="paused" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Hide' }));
  expect(screen.getByRole('button', { name: 'Chat status' })).toBeTruthy();
  fireEvent.focus(window);
  expect((await screen.findByRole('alert')).textContent).toContain('Queue status unavailable');
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
});

it('slows idle polling and avoids overlapping requests', async () => {
  vi.useFakeTimers();
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      codexQueue: { paused: false, connected: true, queued: 0, interrupted: 0, recovering: false },
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
});

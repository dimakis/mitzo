// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiFetch } from '../../lib/api-fetch';
import { CodexQueueStatus } from '../CodexQueueStatus';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));

const meta = (queue: Record<string, unknown>) =>
  ({ ok: true, json: async () => ({ codexQueue: queue }) }) as Response;
const commands = (queued: Array<{ id: string; preview: string }>) =>
  ({ ok: true, json: async () => ({ queued, cancelledIds: [] }) }) as Response;

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
  sessionStorage.clear();
});

it('shows waiting work with a drawer that cancels only an identified queued message', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 2, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(
      commands([
        { id: 'one', preview: 'First saved message' },
        { id: 'two', preview: 'Second saved message' },
      ]),
    )
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, status: 'cancelled' }),
    } as Response)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 1, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'two', preview: 'Second saved message' }]));

  render(<CodexQueueStatus sessionId="task" />);
  await screen.findByText('2 messages are waiting behind the current turn.');
  await userEvent.click(screen.getByRole('button', { name: 'Review queue' }));
  expect(screen.getByText('First saved message')).toBeTruthy();
  expect(screen.getByText('Second saved message')).toBeTruthy();

  await userEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(5));
  expect(apiFetch).toHaveBeenNthCalledWith(
    3,
    '/api/sessions/task/codex-queue/one/cancel',
    expect.objectContaining({ method: 'POST' }),
  );
  expect(screen.queryByText('First saved message')).toBeNull();
  expect(screen.getByText('Second saved message')).toBeTruthy();
});

it.each([
  [
    { paused: false, connected: true, queued: 1, interrupted: 0, recovering: false },
    '1 message is waiting behind the current turn.',
  ],
  [
    {
      paused: true,
      connected: false,
      queued: 0,
      interrupted: 1,
      recovering: true,
      recoveryPhase: 'reconnecting',
    },
    'Reconnecting… Your message is saved.',
  ],
  [
    {
      paused: true,
      connected: true,
      queued: 0,
      interrupted: 0,
      recovering: true,
      recoveryPhase: 'reconnecting',
    },
    'Reconnecting… Your message is saved.',
  ],
])('uses compact, accurate status text', async (queue, label) => {
  vi.mocked(apiFetch).mockResolvedValue(meta(queue));
  render(<CodexQueueStatus sessionId="status" />);
  await screen.findByText(label);
  expect(screen.queryByRole('button', { name: /continue|reconnect/i })).toBeNull();
});

it('hides to an edge control outside the status layout and stays hidden through polling', async () => {
  vi.useFakeTimers();
  vi.mocked(apiFetch).mockResolvedValue(
    meta({
      paused: true,
      connected: true,
      queued: 0,
      interrupted: 1,
      recovering: true,
      recoveryPhase: 'reconnecting',
    }),
  );
  render(<CodexQueueStatus sessionId="paused" />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Hide status' }));
  const tab = screen.getByRole('button', { name: 'Chat status' });
  expect(screen.queryByRole('status')).toBeNull();
  expect(tab.className).toBe('codex-queue-status-tab');

  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(screen.getByRole('button', { name: 'Chat status' })).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});

it('does not fast-poll a paused inactive chat with no queued or recovering work', async () => {
  vi.useFakeTimers();
  vi.mocked(apiFetch).mockResolvedValue(
    meta({ paused: true, connected: false, queued: 0, interrupted: 1, recovering: false }),
  );
  render(<CodexQueueStatus sessionId="inactive" />);
  await act(async () => {});

  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('allows a horizontal swipe to hide and restores focus when the edge control opens', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    meta({
      paused: true,
      connected: true,
      queued: 0,
      interrupted: 1,
      recovering: true,
      recoveryPhase: 'reconnecting',
    }),
  );
  render(<CodexQueueStatus sessionId="swipe" />);
  const status = await screen.findByRole('status');
  fireEvent.pointerDown(status, { clientX: 8, clientY: 12 });
  fireEvent.pointerUp(status, { clientX: 72, clientY: 14 });
  const tab = screen.getByRole('button', { name: 'Chat status' });
  expect(document.activeElement).toBe(tab);
  await userEvent.click(tab);
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Hide status' })),
  );
});

it('consumes a follow-up cancel click after a cancel-originated horizontal gesture', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 1, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'saved', preview: 'Saved prompt' }]));
  render(<CodexQueueStatus sessionId="gesture" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Review queue' }));

  const cancel = screen.getByRole('button', { name: 'Cancel' });
  fireEvent.pointerDown(cancel, { clientX: 8, clientY: 12 });
  fireEvent.pointerUp(cancel, { clientX: 72, clientY: 14 });
  fireEvent.click(cancel, { detail: 1 });

  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('allows the next deliberate pointer or keyboard cancellation when a swipe click is suppressed', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 1, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'saved', preview: 'Saved prompt' }]))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 1, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'saved', preview: 'Saved prompt' }]));
  render(<CodexQueueStatus sessionId="suppressed-gesture" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Review queue' }));

  const cancel = screen.getByRole('button', { name: 'Cancel' });
  fireEvent.pointerDown(cancel, { clientX: 8, clientY: 12 });
  fireEvent.pointerUp(cancel, { clientX: 72, clientY: 14 });
  // No click follows: some touch browsers suppress it after a gesture.
  fireEvent.pointerDown(cancel, { clientX: 8, clientY: 12 });
  fireEvent.pointerUp(cancel, { clientX: 8, clientY: 12 });
  fireEvent.click(cancel, { detail: 1 });

  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(5));
  expect(apiFetch).toHaveBeenNthCalledWith(
    3,
    '/api/sessions/suppressed-gesture/codex-queue/saved/cancel',
    expect.objectContaining({ method: 'POST' }),
  );
});

it('does not swallow keyboard cancellation after a cancel-originated swipe', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 1, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'saved', preview: 'Saved prompt' }]))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 1, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'saved', preview: 'Saved prompt' }]));
  render(<CodexQueueStatus sessionId="keyboard-gesture" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Review queue' }));

  const cancel = screen.getByRole('button', { name: 'Cancel' });
  fireEvent.pointerDown(cancel, { clientX: 8, clientY: 12 });
  fireEvent.pointerUp(cancel, { clientX: 72, clientY: 14 });
  fireEvent.click(cancel, { detail: 0 });

  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(5));
  expect(apiFetch).toHaveBeenNthCalledWith(
    3,
    '/api/sessions/keyboard-gesture/codex-queue/saved/cancel',
    expect.objectContaining({ method: 'POST' }),
  );
});

it('allows an attention status to be dismissed and reports a cancel race honestly', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 1, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'started', preview: 'Saved prompt' }]))
    .mockResolvedValueOnce({ ok: false, status: 409 } as Response)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 0, interrupted: 0, recovering: false }),
    );
  render(<CodexQueueStatus sessionId="race" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Review queue' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(
    await screen.findByText('Could not cancel this message. It may have started; check the queue.'),
  ).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Attention' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Hide status' }));
  expect(screen.getByRole('button', { name: 'Chat status' })).toBeTruthy();
});

it('has no row or edge control when the session is not a Codex chat', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  render(<CodexQueueStatus sessionId="regular" />);
  await act(async () => {});
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Chat status' })).toBeNull();
});

it('does not resurrect a status row for historical interrupted work with nothing waiting', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    meta({ paused: true, connected: false, queued: 0, interrupted: 3, recovering: false }),
  );
  render(<CodexQueueStatus sessionId="completed" />);
  await act(async () => {});
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Chat status' })).toBeNull();
});

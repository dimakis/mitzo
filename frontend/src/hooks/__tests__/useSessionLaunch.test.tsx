// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useSessionLaunch } from '../useSessionLaunch';
import { apiFetch, AUTH_LOST_EVENT } from '../../lib/api-fetch';
import { eventBus } from '../../lib/event-bus-singleton';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn(), AUTH_LOST_EVENT: 'mitzo:auth-lost' }));
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: { on: vi.fn(() => vi.fn()), onConnectionChange: vi.fn(() => vi.fn()) },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it('refreshes matching session events and reconnection without any mutation', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async () => new Response(JSON.stringify({ requests: [] })),
  );
  renderHook(() => useSessionLaunch('current'));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  const changed = vi
    .mocked(eventBus.on)
    .mock.calls.find(([name]) => name === 'session_launch_changed')![1];
  act(() => changed({ sessionId: 'other' }));
  expect(apiFetch).toHaveBeenCalledTimes(1);
  act(() => changed({ sessionId: 'current' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  const connection = vi.mocked(eventBus.onConnectionChange).mock.calls.at(-1)![0];
  act(() => connection(false));
  expect(apiFetch).toHaveBeenCalledTimes(2);
  act(() => connection(true));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.every(
        ([path, init]) =>
          path === '/api/session-launch/requests?sessionId=current' && !init?.method,
      ),
  ).toBe(true);
});

it('refreshes when the document becomes visible and retires event subscriptions on unmount', async () => {
  const offEvent = vi.fn(),
    offConnection = vi.fn();
  vi.mocked(eventBus.on).mockReturnValue(offEvent);
  vi.mocked(eventBus.onConnectionChange).mockReturnValue(offConnection);
  vi.mocked(apiFetch).mockImplementation(
    async () => new Response(JSON.stringify({ requests: [] })),
  );
  const view = renderHook(() => useSessionLaunch('current'));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  view.unmount();
  expect(offEvent).toHaveBeenCalledOnce();
  expect(offConnection).toHaveBeenCalledOnce();
});

it.each([
  ['pending', 5000],
  ['starting', 5000],
  ['created', 5000],
  ['uncertain', 5000],
  ['running', 30000],
  ['failed', 30000],
  ['empty', 30000],
] as const)('uses the %s read-only fallback interval', async (state, interval) => {
  vi.useFakeTimers();
  vi.mocked(apiFetch).mockImplementation(
    async () => new Response(JSON.stringify({ requests: state === 'empty' ? [] : [{ state }] })),
  );
  renderHook(() => useSessionLaunch('current'));
  await act(async () => {});
  expect(apiFetch).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(interval - 1));
  expect(apiFetch).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(1));
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('does not allocate or start sessions while observing requests and provenance', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({ requests: [], origin: { sessionId: 'source', title: 'Source chat' } }),
    ),
  );
  const view = renderHook(() => useSessionLaunch('child'));
  await waitFor(() => expect(view.result.current.origin?.title).toBe('Source chat'));
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it('ignores a previous conversation response and clears relationship data on logout', async () => {
  let resolvePrevious!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation((path) =>
    path.includes('first')
      ? new Promise((resolve) => {
          resolvePrevious = resolve;
        })
      : Promise.resolve(
          new Response(
            JSON.stringify({
              requests: [],
              origin: { sessionId: 'second-source', title: 'Second source' },
            }),
          ),
        ),
  );
  const view = renderHook(({ id }) => useSessionLaunch(id), { initialProps: { id: 'first' } });
  view.rerender({ id: 'second' });
  await waitFor(() => expect(view.result.current.origin?.sessionId).toBe('second-source'));
  await act(async () =>
    resolvePrevious(
      new Response(
        JSON.stringify({
          requests: [],
          origin: { sessionId: 'first-source', title: 'Wrong chat' },
        }),
      ),
    ),
  );
  expect(view.result.current.origin?.sessionId).toBe('second-source');
  act(() => window.dispatchEvent(new Event(AUTH_LOST_EVENT)));
  expect(view.result.current.origin).toBeUndefined();
});

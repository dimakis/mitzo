// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor, act } from '@testing-library/react';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import { TelosWorkApiClient } from '@mitzo/client';
import { useTelosRecords } from '../useTelosRecords';
const updates = vi.hoisted(() => new Set<() => void>());
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: (event: string, listener: () => void) => {
      if (event === 'todo_update') updates.add(listener);
      return () => updates.delete(listener);
    },
  },
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('reads and validates canonical records, reports partial failures, and fences navigation', async () => {
  const fixtures = createTelosWorkFixtures().homeStudio.items;
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async (id) => {
    if (id === 'unavailable') throw Error('offline');
    return fixtures.find((r) => r.itemId === id)!;
  });
  const { result, rerender } = renderHook(({ ids }) => useTelosRecords(ids), {
    initialProps: { ids: [fixtures[0].itemId, 'unavailable'] },
  });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.records).toEqual([fixtures[0]]);
  expect(result.current.unavailable).toEqual(['unavailable']);
  rerender({ ids: [fixtures[1].itemId] });
  await waitFor(() => expect(result.current.records).toEqual([fixtures[1]]));
  expect(result.current.unavailable).toEqual([]);
});

it('preserves the collection owner order rather than replacing priority order with IDs', async () => {
  const records = createTelosWorkFixtures().homeStudio.items;
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async (id) =>
    records.find((r) => r.itemId === id)!,
  );
  const { result } = renderHook(() => useTelosRecords([records[1].itemId, records[0].itemId]));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.records.map((r) => r.itemId)).toEqual([
    records[1].itemId,
    records[0].itemId,
  ]);
});

it('ignores an older navigation read even when its transport resolves after abort', async () => {
  const records = createTelosWorkFixtures().homeStudio.items;
  let release!: (value: (typeof records)[0]) => void;
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation((id) =>
    id === records[0].itemId
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve(records[1]),
  );
  const { result, rerender } = renderHook(({ ids }) => useTelosRecords(ids), {
    initialProps: { ids: [records[0].itemId] },
  });
  rerender({ ids: [records[1].itemId] });
  await waitFor(() => expect(result.current.records).toEqual([records[1]]));
  release(records[0]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(result.current.records).toEqual([records[1]]);
});

it('refreshes every mounted same-ID consumer on item updates and visible resume', async () => {
  const original = createTelosWorkFixtures().homeStudio.items[0];
  let current = original;
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async () =>
    structuredClone(current),
  );
  const tree = renderHook(() => useTelosRecords([original.itemId]));
  const detail = renderHook(() => useTelosRecords([original.itemId]));
  await waitFor(() => expect(tree.result.current.records[0]?.summary).toBe(original.summary));
  await waitFor(() => expect(detail.result.current.records[0]?.summary).toBe(original.summary));
  current = {
    ...original,
    summary: 'Same-ID revised outcome',
    status: 'completed',
    categories: ['Reviewed category'],
  };
  act(() => updates.forEach((listener) => listener()));
  await waitFor(() => expect(tree.result.current.records[0]).toEqual(current));
  await waitFor(() => expect(detail.result.current.records[0]).toEqual(current));
  current = { ...current, summary: 'Changed while away' };
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(tree.result.current.records[0]?.summary).toBe('Changed while away'));
  await waitFor(() => expect(detail.result.current.records[0]?.summary).toBe('Changed while away'));
  tree.unmount();
  detail.unmount();
  expect(updates.size).toBe(0);
});

it('ignores a stale same-ID response after update invalidation even when abort is ignored', async () => {
  const original = createTelosWorkFixtures().homeStudio.items[0];
  const revised = { ...original, summary: 'Current revision' };
  let release!: (record: typeof original) => void;
  let calls = 0;
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(() =>
    ++calls === 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve(revised),
  );
  const { result } = renderHook(() => useTelosRecords([original.itemId]));
  act(() => updates.forEach((listener) => listener()));
  await waitFor(() => expect(result.current.records[0]?.summary).toBe(revised.summary));
  await act(async () => {
    release(original);
    await Promise.resolve();
  });
  expect(result.current.records[0]?.summary).toBe(revised.summary);
});

it('publishes confirmed priority to mounted records, fences earlier reads and retains it through failed refresh', async () => {
  const { setTodoPriority } = await import('../../lib/todo-priority');
  vi.spyOn(await import('../../lib/api-fetch'), 'apiFetch').mockResolvedValue(
    new Response('{"ok":true}'),
  );
  const original = { ...createTelosWorkFixtures().homeStudio.items[0], priority: 5 };
  let release!: (value: typeof original) => void;
  let mode: 'ready' | 'pending' | 'failed' = 'ready';
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(() => {
    if (mode === 'pending')
      return new Promise((resolve) => {
        release = resolve;
      });
    if (mode === 'failed') return Promise.reject(Error('record refresh unavailable'));
    return Promise.resolve(original);
  });
  const tree = renderHook(() => useTelosRecords([original.itemId]));
  const detail = renderHook(() => useTelosRecords([original.itemId]));
  await waitFor(() => expect(tree.result.current.records[0]?.priority).toBe(5));
  await waitFor(() => expect(detail.result.current.records[0]?.priority).toBe(5));
  mode = 'pending';
  act(() => updates.forEach((listener) => listener()));
  mode = 'failed';
  await act(async () => {
    await setTodoPriority(original.itemId, 9);
  });
  await waitFor(() => expect(tree.result.current.records[0]?.priority).toBe(9));
  await waitFor(() => expect(detail.result.current.records[0]?.priority).toBe(9));
  await act(async () => {
    release(original);
    await Promise.resolve();
  });
  expect(detail.result.current.records[0]?.priority).toBe(9);
  expect(detail.result.current.unavailable).toContain(original.itemId);
});

it('accepts later authoritative priority changes once a confirmed write is reconciled', async () => {
  const { setTodoPriority } = await import('../../lib/todo-priority');
  vi.spyOn(await import('../../lib/api-fetch'), 'apiFetch').mockResolvedValue(
    new Response('{"ok":true}'),
  );
  let current = { ...createTelosWorkFixtures().homeStudio.items[1], priority: 5 };
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async () => current);
  const view = renderHook(() => useTelosRecords([current.itemId]));
  await waitFor(() => expect(view.result.current.records[0]?.priority).toBe(5));
  current = { ...current, priority: 9 };
  await act(async () => {
    await setTodoPriority(current.itemId, 9);
  });
  await waitFor(() => expect(view.result.current.records[0]?.priority).toBe(9));
  current = { ...current, priority: 2 };
  act(() => updates.forEach((listener) => listener()));
  await waitFor(() => expect(view.result.current.records[0]?.priority).toBe(2));
});

for (const remount of [false, true])
  it(`accepts an authoritative recovery read after another client changed priority${remount ? ' across navigation/remount' : ''}`, async () => {
    const { setTodoPriority } = await import('../../lib/todo-priority');
    vi.spyOn(await import('../../lib/api-fetch'), 'apiFetch').mockResolvedValue(
      new Response('{"ok":true}'),
    );
    let current = {
      ...createTelosWorkFixtures().homeStudio.items[0],
      itemId: `later-client-${remount}`,
      priority: 5,
    };
    let failed = false;
    vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async () => {
      if (failed) throw Error('temporary record outage');
      return structuredClone(current);
    });
    let view = renderHook(() => useTelosRecords([current.itemId]));
    await waitFor(() => expect(view.result.current.records[0]?.priority).toBe(5));
    failed = true;
    await act(async () => {
      await setTodoPriority(current.itemId, 9);
    });
    await waitFor(() => expect(view.result.current.unavailable).toContain(current.itemId));
    expect(view.result.current.records[0]?.priority).toBe(9);
    // The action was acknowledged, but a different client saved 2 before recovery.
    current = { ...current, priority: 2, updatedAt: '2026-10-17T23:59:00Z' };
    failed = false;
    if (remount) {
      view.unmount();
      view = renderHook(() => useTelosRecords([current.itemId]));
    } else act(() => updates.forEach((listener) => listener()));
    await waitFor(() => expect(view.result.current.unavailable).toEqual([]));
    await waitFor(() => expect(view.result.current.records[0]?.priority).toBe(2));
    act(() => updates.forEach((listener) => listener()));
    await waitFor(() => expect(view.result.current.records[0]?.priority).toBe(2));
  });

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor, act } from '@testing-library/react';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import { TelosWorkApiClient, TelosWorkApiError } from '@mitzo/client';
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
it('hydrates a large collection in bounded batches instead of one request per item', async () => {
  const template = createTelosWorkFixtures().homeStudio.items[0];
  const records = Array.from({ length: 205 }, (_, i) => ({ ...template, itemId: `batch-${i}` }));
  const read = vi.spyOn(TelosWorkApiClient.prototype, 'readRecord');
  const batch = vi
    .spyOn(TelosWorkApiClient.prototype, 'readRecords')
    .mockImplementation(async (ids) => ({
      records: ids
        .filter((id) => id !== 'batch-99')
        .map((id) => records.find((r) => r.itemId === id)!),
      failures: ids.includes('batch-99')
        ? [{ itemId: 'batch-99', code: 'not_found', status: 404 }]
        : [],
    }));
  const view = renderHook(() =>
    useTelosRecords(
      records.map((r) => r.itemId),
      0,
      { batch: true },
    ),
  );
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  expect(batch.mock.calls.map(([ids]) => ids.length)).toEqual([100, 100, 5]);
  expect(read).not.toHaveBeenCalled();
  expect(view.result.current.records).toEqual(records.filter((r) => r.itemId !== 'batch-99'));
  expect(view.result.current.failures).toEqual([
    { itemId: 'batch-99', code: 'not_found', status: 404 },
  ]);
});

it('ignores stale batches after navigation and retains the settled snapshot through refresh', async () => {
  const records = createTelosWorkFixtures().homeStudio.items;
  let release!: (value: { records: typeof records; failures: [] }) => void;
  const batch = vi
    .spyOn(TelosWorkApiClient.prototype, 'readRecords')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ records: [records[1]], failures: [] });
  const view = renderHook(({ ids }) => useTelosRecords(ids, 0, { batch: true }), {
    initialProps: { ids: [records[0].itemId] },
  });
  view.rerender({ ids: [records[1].itemId] });
  await waitFor(() => expect(view.result.current.records).toEqual([records[1]]));
  await act(async () => release({ records: [records[0]], failures: [] }));
  expect(view.result.current.records).toEqual([records[1]]);
  let refresh!: (value: { records: typeof records; failures: [] }) => void;
  batch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        refresh = resolve;
      }),
  );
  act(() => view.result.current.refresh());
  expect(view.result.current.records).toEqual([records[1]]);
  expect(view.result.current.loading).toBe(true);
  await act(async () =>
    refresh({ records: [{ ...records[1], summary: 'Current title' }], failures: [] }),
  );
  expect(view.result.current.records[0].summary).toBe('Current title');
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

it('publishes ready records while another initial record is pending, keeping loading truthful', async () => {
  const records = createTelosWorkFixtures().homeStudio.items;
  let release!: (record: (typeof records)[number]) => void;
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation((id) =>
    id === records[0].itemId
      ? Promise.resolve(records[0])
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  const { result } = renderHook(() => useTelosRecords([records[1].itemId, records[0].itemId]));
  await waitFor(() => expect(result.current.records).toEqual([records[0]]));
  expect(result.current.loading).toBe(true);
  await act(async () => release(records[1]));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.records).toEqual([records[1], records[0]]);
});

it('retains safe failure categories and item identity for HTTP, validation, identity and transport failures', async () => {
  const record = createTelosWorkFixtures().homeStudio.items[0];
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async (id) => {
    if (id === 'http-failure')
      throw new TelosWorkApiError(503, 'fixture_unavailable', 'Do not display raw payload');
    if (id === 'invalid-record') {
      const error = new Error('private schema payload');
      error.name = 'ZodError';
      throw error;
    }
    if (id === 'wrong-identity') return record;
    throw Error('private transport diagnostics');
  });
  const { result } = renderHook(() =>
    useTelosRecords(['http-failure', 'invalid-record', 'wrong-identity', 'transport-failure']),
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.failures).toEqual([
    { itemId: 'http-failure', code: 'fixture_unavailable', status: 503 },
    { itemId: 'invalid-record', code: 'invalid_record' },
    { itemId: 'wrong-identity', code: 'record_identity_mismatch' },
    { itemId: 'transport-failure', code: 'record_read_failed' },
  ]);
  expect(result.current.records).toEqual([]);
  expect(JSON.stringify(result.current.failures)).not.toContain('private');
});

for (const trigger of ['manual', 'todo_update', 'visible resume', 'refresh key'] as const)
  it(`continues initial progressive discovery after ${trigger} interrupts a partial snapshot`, async () => {
    const template = createTelosWorkFixtures().homeStudio.items[0];
    const records = ['A', 'B', 'C'].map((id) => ({
      ...template,
      itemId: `interrupted-${trigger}-${id}`,
      summary: id,
    }));
    type Record = (typeof records)[number];
    const admitted: { id: string; signal: AbortSignal; resolve: (record: Record) => void }[] = [];
    const read = vi
      .spyOn(TelosWorkApiClient.prototype, 'readRecord')
      .mockImplementation(
        (id, signal) => new Promise((resolve) => admitted.push({ id, signal: signal!, resolve })),
      );
    const view = renderHook(
      ({ refreshKey }) =>
        useTelosRecords(
          records.map((record) => record.itemId),
          refreshKey,
        ),
      {
        initialProps: { refreshKey: 0 },
      },
    );
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => admitted[0].resolve(records[0]));
    expect(view.result.current.records).toEqual([records[0]]);
    expect(view.result.current.loading).toBe(true);
    expect(view.result.current.initializing).toBe(true);
    act(() => {
      if (trigger === 'manual') view.result.current.refresh();
      else if (trigger === 'todo_update') updates.forEach((listener) => listener());
      else if (trigger === 'visible resume') {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
        document.dispatchEvent(new Event('visibilitychange'));
      } else view.rerender({ refreshKey: 1 });
    });
    expect(read).toHaveBeenCalledTimes(6);
    expect(admitted.slice(0, 3).every((request) => request.signal.aborted)).toBe(true);
    // The replacement B remains held. Ready A and C must still publish now.
    await act(async () => {
      admitted[3].resolve(records[0]);
      admitted[5].resolve(records[2]);
    });
    expect(view.result.current.records).toEqual([records[0], records[2]]);
    expect(view.result.current.loading).toBe(true);
    expect(view.result.current.initializing).toBe(true);
    // Ignored-abort transport responses from the interrupted run have no authority.
    await act(async () => {
      admitted[1].resolve({ ...records[1], summary: 'Stale B' });
      admitted[2].resolve({ ...records[2], summary: 'Stale C' });
    });
    expect(view.result.current.records).toEqual([records[0], records[2]]);
    expect(view.result.current.loading).toBe(true);
    await act(async () => admitted[4].resolve(records[1]));
    expect(view.result.current.records).toEqual(records);
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.initializing).toBe(false);
    expect(view.result.current.failures).toEqual([]);
    expect(view.result.current.unavailable).toEqual([]);
  });

it('retains the fully settled snapshot through interrupted refreshes until the current replacement settles', async () => {
  const template = createTelosWorkFixtures().homeStudio.items[0];
  const records = ['A', 'B'].map((id) => ({
    ...template,
    itemId: `settled-retention-${id}`,
    summary: id,
  }));
  type Record = (typeof records)[number];
  const admitted: { resolve: (record: Record) => void; signal: AbortSignal }[] = [];
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(
    (_id, signal) => new Promise((resolve) => admitted.push({ resolve, signal: signal! })),
  );
  const view = renderHook(() => useTelosRecords(records.map((record) => record.itemId)));
  await act(async () =>
    admitted.slice(0, 2).forEach((request, index) => request.resolve(records[index])),
  );
  expect(view.result.current.records).toEqual(records);
  expect(view.result.current.initializing).toBe(false);
  act(() => view.result.current.refresh());
  await act(async () => admitted[2].resolve({ ...records[0], summary: 'Interrupted A' }));
  expect(view.result.current.records).toEqual(records);
  expect(view.result.current.loading).toBe(true);
  expect(view.result.current.initializing).toBe(false);
  act(() => updates.forEach((listener) => listener()));
  expect(admitted[3].signal.aborted).toBe(true);
  const revised = records.map((record) => ({ ...record, summary: `Current ${record.summary}` }));
  await act(async () => {
    admitted[4].resolve(revised[0]);
    admitted[3].resolve({ ...records[1], summary: 'Stale B' });
  });
  expect(view.result.current.records).toEqual(records);
  expect(view.result.current.loading).toBe(true);
  expect(view.result.current.initializing).toBe(false);
  await act(async () => admitted[5].resolve(revised[1]));
  expect(view.result.current.records).toEqual(revised);
  expect(view.result.current.loading).toBe(false);
  expect(view.result.current.initializing).toBe(false);
});

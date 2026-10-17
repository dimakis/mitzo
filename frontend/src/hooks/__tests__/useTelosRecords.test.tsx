// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import { TelosWorkApiClient } from '@mitzo/client';
import { useTelosRecords } from '../useTelosRecords';
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

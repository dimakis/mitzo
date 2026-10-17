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

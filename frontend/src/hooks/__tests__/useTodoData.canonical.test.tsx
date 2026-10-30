// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { useTodoData } from '../useTodoData';
import { markAuthLost } from '../../lib/api-fetch';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
const fetchMock = vi.fn();
beforeEach(() => {
  markAuthLost();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('shares one native collection request and projects cross-profile children without record hydration calls', async () => {
  const records = createTelosWorkFixtures().homeStudio.items;
  records[1] = { ...records[1], profile: 'manual' };
  fetchMock.mockImplementation(async () =>
    Response.json({ profiles: ['work', 'manual'], records, failures: [] }),
  );
  const first = renderHook(() => useTodoData(undefined, undefined, 'active', 'canonical'));
  const second = renderHook(() => useTodoData(undefined, undefined, 'active', 'canonical'));
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  await waitFor(() => expect(second.result.current.loading).toBe(false));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0][0])).toContain('/api/telos/work/collection');
  expect(first.result.current.records).toEqual(records);
  expect(
    first.result.current.items
      .find((item) => item.id === records[0].itemId)
      ?.children.map((item) => item.id),
  ).toContain(records[1].itemId);
});
it('does not read a disabled legacy fallback while native discovery is active', async () => {
  const hook = renderHook(() => useTodoData(undefined, undefined, 'active', 'legacy', false));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(hook.result.current.items).toEqual([]);
});

it('filters canonical profiles locally while retaining cross-profile children under the selected parent', async () => {
  const records = createTelosWorkFixtures().homeStudio.items.map((record, index) => ({
    ...record,
    profile: index === 0 ? 'work' : 'manual',
  }));
  fetchMock.mockImplementation(async () =>
    Response.json({ records, profiles: ['work', 'manual'], failures: [] }),
  );
  const parent = renderHook(() => useTodoData('work', undefined, 'active', 'canonical'));
  const child = renderHook(() => useTodoData('manual', undefined, 'active', 'canonical'));
  await waitFor(() => expect(parent.result.current.loading).toBe(false));
  await waitFor(() => expect(child.result.current.loading).toBe(false));
  expect(parent.result.current.items.map((item) => item.id)).toEqual([records[0].itemId]);
  expect(parent.result.current.items[0].children.map((item) => item.id)).toEqual([
    records[1].itemId,
  ]);
  expect(child.result.current.items.map((item) => item.id)).toEqual([records[1].itemId]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
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

it('shares a cold resolving read between detail and controls without superseding peers', async () => {
  let finish!: (value: Response) => void;
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const first = renderHook(() => useTodoData(undefined, 'fixture-studio', 'active', 'canonical'));
  const second = renderHook(() => useTodoData(undefined, 'fixture-studio', 'active', 'canonical'));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () =>
    finish(
      Response.json({
        records: createTelosWorkFixtures().homeStudio.items,
        profiles: ['work'],
        failures: [],
      }),
    ),
  );
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  await waitFor(() => expect(second.result.current.loading).toBe(false));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it.each([false, true])(
  'retires a pre-creation collection once and shares the fresh admission (new completes first: %s)',
  async (newFirst) => {
    const pending: ((value: Response) => void)[] = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));
    const previous = renderHook(() => useTodoData(undefined, undefined, 'active', 'canonical'));
    const first = renderHook(() => useTodoData(undefined, 'fixture-studio', 'active', 'canonical'));
    const second = renderHook(() =>
      useTodoData(undefined, 'fixture-studio', 'active', 'canonical'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const finishOld = () => pending[0](Response.json({ records: [], profiles: [], failures: [] }));
    const finishNew = () =>
      pending[1](
        Response.json({
          records: createTelosWorkFixtures().homeStudio.items,
          profiles: ['work'],
          failures: [],
        }),
      );
    await act(async () => (newFirst ? finishNew() : finishOld()));
    await act(async () => (newFirst ? finishOld() : finishNew()));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    await waitFor(() => expect(previous.result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  },
);

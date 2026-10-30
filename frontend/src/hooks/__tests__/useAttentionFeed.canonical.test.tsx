// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { useAttentionFeed } from '../useAttentionFeed';
import { useTodoData } from '../useTodoData';
import { markAuthLost } from '../../lib/api-fetch';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
const state = { tasks: { tree: [] }, loadTasks: vi.fn() };
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (value: typeof state) => unknown) => select(state),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('shares canonical discovery with Work and keeps persisted identities in Today links', async () => {
  markAuthLost();
  const record = {
    ...createTelosWorkFixtures().homeStudio.items[0],
    itemId: 'persisted-report',
    starred: true,
    legacyFields: { item: { urgency: 0.9 } },
  };
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ records: [record], profiles: ['work'], failures: [] }));
  const view = renderHook(() => ({
    feed: useAttentionFeed(),
    work: useTodoData(undefined, undefined, 'active', 'canonical'),
  }));
  await waitFor(() => expect(view.result.current.feed.loading).toBe(false));
  expect(view.result.current.feed.items.find((item) => item.source === 'telos')?.navigateTo).toBe(
    '/todos/persisted-report',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0][0])).toBe('/api/telos/work/collection');
});

it('keeps partial canonical discovery explicit without another hydration pass', async () => {
  markAuthLost();
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      records: [],
      profiles: [],
      failures: [{ itemId: 'invalid-report', code: 'invalid_record' }],
    }),
  );
  const view = renderHook(() => useAttentionFeed());
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  expect(view.result.current.error).toBe('Couldn’t load attention items. Try again.');
  expect(fetch).toHaveBeenCalledTimes(1);
});

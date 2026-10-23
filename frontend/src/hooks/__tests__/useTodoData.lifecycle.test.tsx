// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  invalidateTodoReads: vi.fn(),
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
  AUTH_RESTORED_EVENT: 'mitzo:auth-restored',
}));
vi.mock('../../lib/event-bus-singleton', () => ({ eventBus: { on: () => () => {} } }));
import { apiFetch } from '../../lib/api-fetch';
import { useTodoData } from '../useTodoData';
import { notifyTodoLifecycleChange } from '../../lib/todo-lifecycle-events';
import type { TodoItem } from '../../types/todo';
const item: TodoItem = {
  id: 'active',
  summary: 'Active outcome',
  profile: 'work',
  urgency: 0.5,
  starred: false,
  status: 'active',
  ageDays: 0,
  parentId: null,
  children: [],
  childCount: 0,
  completedChildCount: 0,
  sources: [],
  goalId: null,
  contextHints: {
    repos: [],
    paths: [],
    issues: [],
    docIds: [],
    people: [],
    jiraKeys: [],
    keywords: [],
    taskHint: '',
  },
};
const response = (items: TodoItem[]) => Response.json({ profiles: ['work'], items });
beforeEach(() => {
  window.dispatchEvent(new Event('mitzo:auth-lost'));
  vi.mocked(apiFetch).mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('uses the actual archive/trash query and never exposes active rows while a new view is pending', async () => {
  let release!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).includes('view=archive')
      ? new Promise((resolve) => {
          release = resolve;
        })
      : response([item]),
  );
  const { result, rerender } = renderHook(({ view }) => useTodoData('work', undefined, view), {
    initialProps: { view: 'active' as 'active' | 'archive' | 'trash' },
  });
  await waitFor(() => expect(result.current.items).toEqual([item]));
  expect(apiFetch).toHaveBeenCalledWith('/api/todos?profile=work');
  rerender({ view: 'archive' });
  expect(result.current.items).toEqual([]);
  expect(result.current.loading).toBe(true);
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith('/api/todos?profile=work&view=archive'),
  );
  const archived = { ...item, id: 'archived', summary: 'Archived outcome' };
  await act(async () => release(response([archived])));
  await waitFor(() => expect(result.current.items).toEqual([archived]));
  rerender({ view: 'trash' });
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/todos?profile=work&view=trash'));
  expect(result.current.items).not.toEqual([archived]);
});
it('clears stale view snapshots and revalidates every mounted collection only after an acknowledged lifecycle notification', async () => {
  let active = [item];
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(String(url).includes('view=archive') ? [{ ...item, id: 'archived' }] : active),
  );
  const first = renderHook(() => useTodoData());
  const second = renderHook(() => useTodoData(undefined, undefined, 'archive'));
  await waitFor(() => expect(first.result.current.items).toHaveLength(1));
  await waitFor(() => expect(second.result.current.items[0]?.id).toBe('archived'));
  const before = vi.mocked(apiFetch).mock.calls.length;
  active = [];
  act(() => notifyTodoLifecycleChange());
  await waitFor(() => expect(first.result.current.items).toEqual([]));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(before + 2));
  await waitFor(() => expect(second.result.current.items[0]?.id).toBe('archived'));
});

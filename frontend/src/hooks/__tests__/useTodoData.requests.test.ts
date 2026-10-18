// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { markAuthLost } from '../../lib/api-fetch';
import { useTodoData } from '../useTodoData';
import type { TodoItem } from '../../types/todo';
vi.mock('../../lib/event-bus-singleton', () => ({ eventBus: { on: () => () => {} } }));
const fetchMock = vi.fn();
const createdItem: TodoItem = {
  id: 'created',
  summary: 'Created',
  profile: 'work',
  priority: 5,
  urgency: 0,
  starred: false,
  status: 'active',
  ageDays: 0,
  parentId: null,
  children: [],
  childCount: 0,
  completedChildCount: 0,
  goalId: null,
  sources: [],
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
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  localStorage.clear();
  markAuthLost();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(['refresh', 'create', 'outcome'] as const)(
  '%s reads current Telos data even if an earlier HTTP request is still pending',
  async (operation) => {
    let finishOld!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishOld = resolve;
        }),
    );
    const hook = renderHook(() => useTodoData());
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      Response.json(
        init?.method === 'POST' ? { item: createdItem } : { profiles: [], items: [createdItem] },
      ),
    );
    await act(async () => {
      if (operation === 'refresh') hook.result.current.refresh();
      else if (operation === 'create') await hook.result.current.create('Created', 'work');
      else
        await hook.result.current.createOutcome({
          summary: 'Created',
          profile: 'work',
          intent: 'Ship change',
          rationale: 'Reduce delay',
          acceptanceCriteria: [],
          milestones: [],
          idempotencyKey: 'fixture',
        });
    });
    await waitFor(() =>
      expect(hook.result.current.items.map((item) => item.id)).toEqual(['created']),
    );
    await act(async () => finishOld(Response.json({ profiles: [], items: [] })));
    expect(hook.result.current.items.map((item) => item.id)).toEqual(['created']);
    expect(hook.result.current.loading).toBe(false);
  },
);

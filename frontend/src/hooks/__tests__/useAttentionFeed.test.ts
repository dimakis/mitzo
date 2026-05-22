// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// ─── Mocks ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockEventBusOn: any = vi.fn(() => vi.fn());

vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: (...args: unknown[]) => mockEventBusOn(...args),
  },
}));

vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

const mockTasks = { tree: [], loopStatus: { state: 'idle' } };
const mockLoadTasks = vi.fn();

vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ tasks: mockTasks, loadTasks: mockLoadTasks }),
}));

import { useAttentionFeed } from '../useAttentionFeed';
import { apiFetch } from '../../lib/api-fetch';
import type { TodoItem } from '../../types/todo';

const mockApiFetch = vi.mocked(apiFetch);

function makeTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 'todo-1',
    summary: 'Test todo',
    profile: 'work',
    urgency: 0.5,
    starred: false,
    status: 'active',
    ageDays: 3,
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
    ...overrides,
  };
}

beforeEach(() => {
  mockEventBusOn.mockClear();
  mockLoadTasks.mockClear();
  mockApiFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAttentionFeed', () => {
  it('loads todos from API on mount', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    } as Response);

    renderHook(() => useAttentionFeed());

    expect(mockApiFetch).toHaveBeenCalledWith('/api/todos');
  });

  it('loads tasks from store on mount', () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    } as Response);

    renderHook(() => useAttentionFeed());

    expect(mockLoadTasks).toHaveBeenCalled();
  });

  it('returns starred high-urgency todos as tier 1', async () => {
    const items = [
      makeTodo({ id: 't1', summary: 'Urgent starred', starred: true, urgency: 0.9 }),
      makeTodo({ id: 't2', summary: 'Normal item', starred: false, urgency: 0.3 }),
    ];
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items }),
    } as Response);

    const { result } = renderHook(() => useAttentionFeed());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].title).toBe('Urgent starred');
    expect(result.current.items[0].tier).toBe(1);
    expect(result.current.tier1Count).toBe(1);
  });

  it('returns starred low-urgency todos as tier 2', async () => {
    const items = [
      makeTodo({ id: 't1', summary: 'Starred low urgency', starred: true, urgency: 0.3 }),
    ];
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items }),
    } as Response);

    const { result } = renderHook(() => useAttentionFeed());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].tier).toBe(2);
  });

  it('returns unstarred very-high-urgency todos as tier 2', async () => {
    const items = [
      makeTodo({ id: 't1', summary: 'Critical unstarred', starred: false, urgency: 0.9 }),
    ];
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items }),
    } as Response);

    const { result } = renderHook(() => useAttentionFeed());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].tier).toBe(2);
  });

  it('sorts tier 1 items before tier 2', async () => {
    const items = [
      makeTodo({ id: 't1', summary: 'Starred low', starred: true, urgency: 0.3 }),
      makeTodo({ id: 't2', summary: 'Starred high', starred: true, urgency: 0.8 }),
    ];
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items }),
    } as Response);

    const { result } = renderHook(() => useAttentionFeed());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.items[0].title).toBe('Starred high');
    expect(result.current.items[0].tier).toBe(1);
    expect(result.current.items[1].title).toBe('Starred low');
    expect(result.current.items[1].tier).toBe(2);
  });

  it('returns all items without capping', async () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeTodo({ id: `t${i}`, summary: `Item ${i}`, starred: true, urgency: 0.9 }),
    );
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items }),
    } as Response);

    const { result } = renderHook(() => useAttentionFeed());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.items).toHaveLength(10);
    expect(result.current.tier1Count).toBe(10);
  });

  it('subscribes to SSE events for live updates', () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    } as Response);

    renderHook(() => useAttentionFeed());

    const eventNames = mockEventBusOn.mock.calls.map((c: unknown[]) => c[0]);
    expect(eventNames).toContain('todo_update');
    expect(eventNames).toContain('task_state');
    expect(eventNames).toContain('session_activity');
  });

  it('handles API failure gracefully', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useAttentionFeed());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.items).toEqual([]);
  });

  describe('sessionsToAttention (via session_activity events)', () => {
    function emptyApiMock() {
      mockApiFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ items: [] }),
      } as Response);
    }

    function getSessionActivityHandler(): (data: unknown) => void {
      const call = mockEventBusOn.mock.calls.find((c: unknown[]) => c[0] === 'session_activity');
      return call[1];
    }

    it('shows awaiting-reply sessions as tier 1', async () => {
      emptyApiMock();
      const { result } = renderHook(() => useAttentionFeed());
      await waitFor(() => expect(result.current.loading).toBe(false));

      const handler = getSessionActivityHandler();
      handler([
        {
          sessionId: 's1',
          clientId: 'c1',
          title: 'Awaiting session',
          state: 'done',
          flags: [],
          lastEventAt: Date.now(),
          awaitingReply: true,
        },
      ]);

      await waitFor(() => {
        expect(result.current.items).toHaveLength(1);
      });
      expect(result.current.items[0].source).toBe('session');
      expect(result.current.items[0].tier).toBe(1);
      expect(result.current.items[0].meta).toBe('awaiting reply');
    });

    it('shows waiting sessions with correct meta', async () => {
      emptyApiMock();
      const { result } = renderHook(() => useAttentionFeed());
      await waitFor(() => expect(result.current.loading).toBe(false));

      const handler = getSessionActivityHandler();
      handler([
        {
          sessionId: 's2',
          clientId: 'c2',
          title: 'Permission session',
          state: 'waiting',
          flags: [],
          waitReason: 'permission',
          lastEventAt: Date.now(),
        },
      ]);

      await waitFor(() => {
        expect(result.current.items).toHaveLength(1);
      });
      expect(result.current.items[0].meta).toBe('permission needed');
    });

    it('shows uncommitted work sessions as tier 1', async () => {
      emptyApiMock();
      const { result } = renderHook(() => useAttentionFeed());
      await waitFor(() => expect(result.current.loading).toBe(false));

      const handler = getSessionActivityHandler();
      handler([
        {
          sessionId: 's3',
          clientId: 'c3',
          title: 'Dirty session',
          state: 'done',
          flags: [],
          lastEventAt: Date.now(),
          uncommittedWork: true,
        },
      ]);

      await waitFor(() => {
        expect(result.current.items).toHaveLength(1);
      });
      expect(result.current.items[0].meta).toBe('uncommitted work');
      expect(result.current.items[0].tier).toBe(1);
    });

    it('ignores working/init sessions', async () => {
      emptyApiMock();
      const { result } = renderHook(() => useAttentionFeed());
      await waitFor(() => expect(result.current.loading).toBe(false));

      const handler = getSessionActivityHandler();
      handler([
        {
          sessionId: 's4',
          clientId: 'c4',
          title: 'Working session',
          state: 'working',
          flags: [],
          lastEventAt: Date.now(),
        },
      ]);

      // No attention items from a working session
      await waitFor(() => {
        expect(result.current.items).toHaveLength(0);
      });
    });

    it('shows done sessions as tier 2', async () => {
      emptyApiMock();
      const { result } = renderHook(() => useAttentionFeed());
      await waitFor(() => expect(result.current.loading).toBe(false));

      const handler = getSessionActivityHandler();
      handler([
        {
          sessionId: 's5',
          clientId: 'c5',
          title: 'Finished session',
          state: 'done',
          flags: [],
          lastEventAt: Date.now(),
        },
      ]);

      await waitFor(() => {
        expect(result.current.items).toHaveLength(1);
      });
      expect(result.current.items[0].tier).toBe(2);
      expect(result.current.items[0].meta).toBe('done');
    });
  });
});

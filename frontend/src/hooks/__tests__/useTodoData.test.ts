// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';

vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  invalidateTodoReads: vi.fn(),
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
  AUTH_RESTORED_EVENT: 'mitzo:auth-restored',
}));

vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: vi.fn(() => vi.fn()),
    onConnectionChange: vi.fn(() => vi.fn()),
    connected: false,
  },
}));

import { apiFetch } from '../../lib/api-fetch';
import { useTodoData } from '../useTodoData';
import { ListCache } from '../../lib/list-cache';

const mockItems = [
  {
    id: 'abc123',
    summary: '[dimakis/mitzo#1] Fix bug',
    profile: 'centaur',
    urgency: 0.5,
    starred: false,
    status: 'active' as const,
    ageDays: 3,
    parentId: null,
    children: [],
    childCount: 0,
    completedChildCount: 0,
    sources: [
      {
        type: 'github',
        url: 'https://github.com/dimakis/mitzo/issues/1',
        title: 'Fix bug',
        author: 'dimakis',
        snippet: '',
      },
    ],
    contextHints: {
      repos: ['dimakis/mitzo'],
      paths: [],
      issues: ['dimakis/mitzo#1'],
      docIds: [],
      people: [],
      jiraKeys: [],
      keywords: [],
      taskHint: 'Fix bug',
    },
  },
];

const mockResponse = {
  profiles: ['centaur', 'work', 'personal'],
  items: mockItems,
};

beforeEach(() => {
  window.dispatchEvent(new Event('mitzo:auth-lost'));
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(mockResponse),
  } as Response);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useTodoData', () => {
  it('keeps a confirmation delivered between read publication and promise completion in both mounted consumers', async () => {
    const list = renderHook(() => useTodoData('work'));
    const detail = renderHook(() => useTodoData());
    await waitFor(() => expect(list.result.current.loading).toBe(false));
    await waitFor(() => expect(detail.result.current.loading).toBe(false));
    let confirm!: (value: { ok: true }) => void;
    let awaitingConfirmation = false;
    const confirmation = new Promise<{ ok: true }>((resolve) => {
      confirm = resolve;
    });
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => {
        awaitingConfirmation = true;
        return confirmation;
      },
    } as Response);
    let save!: Promise<void>;
    act(() => {
      save = detail.result.current.setPriority('abc123', 7);
    });
    await waitFor(() => expect(awaitingConfirmation).toBe(true));
    const olderRead = { ...mockResponse, items: [{ ...mockItems[0], priority: 3 }] };
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => olderRead,
    } as Response);
    const publish = ListCache.prototype.set;
    vi.spyOn(ListCache.prototype, 'set').mockImplementation(function (
      this: ListCache<unknown>,
      key,
      data,
    ) {
      Reflect.apply(publish, this, [key, data]);
      // The read has passed its generation check and published. The write's
      // JSON continuation now runs before the read's finally/consumer delivery.
      if (key === '/api/todos' && data === olderRead) confirm({ ok: true });
    });
    act(() => detail.result.current.refresh());
    await act(async () => {
      await save;
    });
    expect(list.result.current.items[0].priority).toBe(7);
    expect(detail.result.current.items[0].priority).toBe(7);
    expect(detail.result.current.error).toBeNull();
  });

  it('publishes confirmed priority to simultaneously mounted list and detail consumers', async () => {
    const list = renderHook(() => useTodoData('work'));
    const detail = renderHook(() => useTodoData());
    await waitFor(() => expect(list.result.current.loading).toBe(false));
    await waitFor(() => expect(detail.result.current.loading).toBe(false));
    vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
    await act(async () => detail.result.current.setPriority('abc123', 7));
    expect(detail.result.current.items[0].priority).toBe(7);
    expect(list.result.current.items[0].priority).toBe(7);
  });

  it.each([true, false])(
    'orders priority writes across navigation when the first save succeeds=%s',
    async (firstSucceeds) => {
      const first = renderHook(() => useTodoData());
      await waitFor(() => expect(first.result.current.loading).toBe(false));
      let finishFirst!: (response: Response) => void;
      vi.mocked(apiFetch).mockImplementationOnce(
        () => new Promise<Response>((resolve) => (finishFirst = resolve)),
      );
      let older!: Promise<void>;
      act(() => {
        older = first.result.current.setPriority('abc123', 7);
      });
      // Handle rejection before intentionally holding the request across a remount.
      const olderResult = older.catch(() => {});
      first.unmount();
      const second = renderHook(() => useTodoData());
      await waitFor(() => expect(second.result.current.loading).toBe(false));
      vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
      let newer!: Promise<void>;
      act(() => {
        newer = second.result.current.setPriority('abc123', 9);
      });
      expect(
        vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST'),
      ).toHaveLength(1);
      await act(async () => {
        finishFirst(Response.json({ ok: firstSucceeds }));
        await olderResult;
        await newer;
      });
      expect(second.result.current.items[0].priority).toBe(9);
      expect(
        vi
          .mocked(apiFetch)
          .mock.calls.filter(([, init]) => init?.method === 'POST')
          .map(([, init]) => JSON.parse(init!.body as string).priority),
      ).toEqual([7, 9]);
      const third = renderHook(() => useTodoData());
      expect(third.result.current.items[0].priority).toBe(9);
    },
  );

  it('publishes confirmed numeric priority and keeps it when a later save fails', async () => {
    const { result } = renderHook(() => useTodoData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{"ok":true}'));
    await act(async () => result.current.setPriority('abc123', 7));
    expect(result.current.items[0].priority).toBe(7);
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/api/todos/abc123/action',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'priority', priority: 7 }),
      }),
    );
    vi.mocked(apiFetch).mockRejectedValueOnce(Error('lost response'));
    await act(async () => {
      await expect(result.current.setPriority('abc123', 9)).rejects.toThrow();
    });
    expect(result.current.items[0].priority).toBe(7);
  });

  it('does not publish an unconfirmed priority while the request is pending or returns ok false', async () => {
    const { result } = renderHook(() => useTodoData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    let finish!: (response: Response) => void;
    vi.mocked(apiFetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    let request!: Promise<void>;
    act(() => {
      request = result.current.setPriority('abc123', 8);
    });
    expect(result.current.items[0].priority).toBeUndefined();
    await act(async () => {
      finish(new Response('{"ok":false}'));
      await expect(request).rejects.toThrow();
    });
    expect(result.current.items[0].priority).toBeUndefined();
  });
  it.each(['rejected', 'network'])(
    'reports an unconfirmed star after %s without retrying the mutation',
    async (failure) => {
      const { result } = renderHook(() => useTodoData());
      await waitFor(() => expect(result.current.loading).toBe(false));
      if (failure === 'rejected')
        vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}', { status: 503 }));
      else vi.mocked(apiFetch).mockRejectedValueOnce(Error('network unavailable'));
      await act(async () => {
        await result.current.star('abc123');
      });
      expect(result.current.error).toBe(
        'Couldn’t confirm this change. Refresh to check its status.',
      );
      expect(apiFetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['rejected', 'network'])(
    'rejects unconfirmed creation after %s so the form can retain its draft',
    async (failure) => {
      const { result } = renderHook(() => useTodoData());
      await waitFor(() => expect(result.current.loading).toBe(false));
      if (failure === 'rejected')
        vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}', { status: 503 }));
      else vi.mocked(apiFetch).mockRejectedValueOnce(Error('network unavailable'));
      await act(async () => {
        await expect(result.current.create('Retained draft', 'work', 'parent')).rejects.toThrow(
          'Couldn’t confirm creation. Refresh to check its status.',
        );
      });
      expect(apiFetch).toHaveBeenCalledTimes(2);
    },
  );

  it('fetches todo items on mount', async () => {
    const { result } = renderHook(() => useTodoData());

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items).toHaveLength(1);
    expect(result.current.profiles).toEqual(['centaur', 'work', 'personal']);
    expect(apiFetch).toHaveBeenCalledWith('/api/todos');
  });

  it('fetches with profile filter', async () => {
    const { result } = renderHook(() => useTodoData('centaur'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(apiFetch).toHaveBeenCalledWith('/api/todos?profile=centaur');
  });

  it('handles fetch errors gracefully', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items).toEqual([]);
    expect(result.current.profiles).toEqual([]);
    expect(result.current.error).toBe('Unable to load Telos items');
  });

  it('reports non-success responses as errors', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 502 } as Response);

    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('Unable to load Telos items');
  });

  it('performs action and removes item from list', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.ack('abc123');
    });

    expect(result.current.items).toHaveLength(0);
    expect(apiFetch).toHaveBeenCalledWith('/api/todos/abc123/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ack' }),
    });
  });

  it('performs done action', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.done('abc123');
    });

    expect(result.current.items).toHaveLength(0);
  });

  it('performs snooze action with days parameter', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.snooze('abc123', 5);
    });

    expect(result.current.items).toHaveLength(0);
    expect(apiFetch).toHaveBeenCalledWith('/api/todos/abc123/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'snooze', days: 5 }),
    });
  });

  it('refresh triggers a re-fetch', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiFetch).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('handles network error in performAction gracefully', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Network error'));

    await act(async () => {
      await result.current.ack('abc123');
    });

    expect(result.current.error).toBe('Couldn’t confirm this change. Refresh to check its status.');
    // Item should still be in the list since action failed
    expect(result.current.items).toHaveLength(1);
  });

  it.each(['ack', 'done', 'snooze'] as const)(
    'reports rejected %s without removing the outcome',
    async (action) => {
      const { result } = renderHook(() => useTodoData());
      await waitFor(() => expect(result.current.loading).toBe(false));
      vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}', { status: 503 }));
      await act(async () => {
        await result.current[action]('abc123');
      });
      expect(result.current.items).toHaveLength(1);
      expect(result.current.error).toBe(
        'Couldn’t confirm this change. Refresh to check its status.',
      );
    },
  );

  it('create posts to /api/todos and triggers refresh', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiFetch).toHaveBeenCalledTimes(1);

    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.create('New task', 'work');
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'New task', profile: 'work' }),
    });
  });

  it('create passes parentId when provided', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.create('Sub task', 'work', 'parent-123');
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'Sub task', profile: 'work', parentId: 'parent-123' }),
    });
  });

  it('createOutcome posts the complete outcome contract', async () => {
    const { result } = renderHook(() => useTodoData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const draft = {
      summary: 'Ship searchable outcomes',
      intent: 'People understand durable work in ten seconds.',
      rationale: 'Progress logs currently obscure intent.',
      acceptanceCriteria: ['Search matches outcome and context'],
      milestones: ['Add the structured contract'],
      profile: 'work',
      idempotencyKey: 'session-1:message-7',
    };
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, item: { id: 'created' } }),
    } as Response);

    let created;
    await act(async () => {
      created = await result.current.createOutcome(draft);
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/todos/outcomes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    expect(created).toEqual({ id: 'created' });
  });

  it('create rejects a network failure while keeping existing items', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Network error'));

    await act(async () => {
      await expect(result.current.create('New task', 'work')).rejects.toThrow(
        'Couldn’t confirm creation. Refresh to check its status.',
      );
    });

    // The form retains its draft when this operation rejects.
    expect(result.current.items).toHaveLength(1);
  });

  it('star optimistically toggles starred state', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items[0].starred).toBe(false);

    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.star('abc123');
    });

    // Optimistic toggle: starred should now be true
    expect(result.current.items[0].starred).toBe(true);
  });

  it('star sends correct action based on current state', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    // First star: item is unstarred, so action should be 'star'
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.star('abc123');
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/todos/abc123/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'star' }),
    });

    // Second star: item is now starred, so action should be 'unstar'
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.star('abc123');
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/todos/abc123/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unstar' }),
    });
  });

  it('star handles network error gracefully — optimistic update persists', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items[0].starred).toBe(false);

    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Network error'));

    await act(async () => {
      await result.current.star('abc123');
    });

    // Optimistic toggle persists despite network error
    expect(result.current.items[0].starred).toBe(true);
  });
});

it('keeps Telos items visible during refresh, including a failed refresh', async () => {
  const { result } = renderHook(() => useTodoData());
  await waitFor(() => expect(result.current.loading).toBe(false));
  let finish!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  act(() => result.current.refresh());
  expect(result.current.loading).toBe(false);
  expect(result.current.items).toEqual(mockItems);
  await act(async () => finish(Response.json({}, { status: 503 })));
  await waitFor(() => expect(result.current.error).toBe('Unable to load Telos items'));
  expect(result.current.items).toEqual(mockItems);
});

it('restores the same profile immediately on remount and keeps profiles separate', async () => {
  const first = renderHook(() => useTodoData('centaur'));
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  first.unmount();
  vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>(() => {}));
  const restored = renderHook(() => useTodoData('centaur'));
  expect(restored.result.current.loading).toBe(false);
  expect(restored.result.current.items).toEqual(mockItems);
  const other = renderHook(() => useTodoData('personal'));
  expect(other.result.current.loading).toBe(true);
  expect(other.result.current.items).toEqual([]);
});

it('retries an uncached profile read invalidated by an action finishing after a profile switch', async () => {
  const hook = renderHook(({ profile }) => useTodoData(profile), {
    initialProps: { profile: 'work' },
  });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  let finishAction!: (response: Response) => void;
  let finishRead!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishAction = resolve;
      }),
  );
  let action!: Promise<void>;
  act(() => {
    action = hook.result.current.done('abc123');
  });
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  );
  hook.rerender({ profile: 'personal' });
  expect(hook.result.current.loading).toBe(true);
  await act(async () => {
    finishAction(Response.json({ ok: true }));
    await action;
  });
  await act(async () => finishRead(Response.json({ profiles: ['personal'], items: [] })));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(apiFetch).toHaveBeenLastCalledWith('/api/todos?profile=personal');
});

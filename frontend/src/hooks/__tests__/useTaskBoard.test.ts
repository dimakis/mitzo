// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTaskBoard } from '../useTaskBoard';
import type { Task } from '../../types/task';

// Mock ws-pool
const listeners: Array<(msg: unknown) => void> = [];
vi.mock('../../lib/ws-pool', () => ({
  wsSubscribe: vi.fn((_key: string, listener: (msg: unknown) => void) => {
    listeners.push(listener);
    return () => {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    parentId: null,
    title: 'Test task',
    description: null,
    status: 'pending',
    sessionId: null,
    sessionPolicy: 'auto',
    priority: 0,
    depth: 0,
    annotations: [],
    summary: null,
    requiresApproval: false,
    tokenUsage: 0,
    claimedBy: null,
    claimedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    children: [],
    ...overrides,
  };
}

const defaultLoopStatus = {
  state: 'idle',
  goalId: null,
  activeTaskId: null,
  progress: null,
  specMode: false,
  awaitingApproval: false,
};

let fetchMock: ReturnType<typeof vi.fn>;
let taskResponse: { tasks: Task[] };
let mutationResponses: Array<{ ok: boolean; status?: number; json?: () => Promise<unknown> }>;

function setupFetch(tasks: Task[] = []) {
  taskResponse = { tasks };
  mutationResponses = [];
  fetchMock = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    if (url === '/api/loop/status') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(defaultLoopStatus),
      });
    }
    if (url === '/api/tasks' && (!opts || opts.method === undefined || opts.method === 'GET')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(taskResponse),
      });
    }
    // Mutation calls — pop from queue or default to ok
    const resp = mutationResponses.shift();
    if (resp) {
      return Promise.resolve({
        ok: resp.ok,
        status: resp.status ?? (resp.ok ? 200 : 500),
        json: resp.json ?? (() => Promise.resolve({})),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  listeners.length = 0;
  setupFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useTaskBoard', () => {
  it('fetches tasks on mount', async () => {
    const tasks = [makeTask()];
    setupFetch(tasks);

    const { result } = renderHook(() => useTaskBoard());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tasks).toEqual(tasks);
  });

  it('createTask calls POST and relies on WS for state', async () => {
    const { result } = renderHook(() => useTaskBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.createTask({ title: 'New task' });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('updateTask calls PATCH', async () => {
    setupFetch([makeTask()]);
    const { result } = renderHook(() => useTaskBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.updateTask('task-1', { title: 'Updated' });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/task-1',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('deleteTask calls DELETE', async () => {
    setupFetch([makeTask()]);
    const { result } = renderHook(() => useTaskBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.deleteTask('task-1');
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/task-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('WS task_state replaces state', async () => {
    const { result } = renderHook(() => useTaskBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const newTasks = [makeTask({ id: 'ws-1', title: 'From WS' })];
    act(() => {
      listeners.forEach((l) => l({ type: 'task_state', tasks: newTasks }));
    });

    expect(result.current.tasks).toEqual(newTasks);
  });

  it('WS task_updated upserts a new task into roots', async () => {
    const { result } = renderHook(() => useTaskBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const newTask = makeTask({ id: 'new-1', title: 'New via WS' });
    act(() => {
      listeners.forEach((l) => l({ type: 'task_updated', task: newTask }));
    });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0].title).toBe('New via WS');
  });

  it('WS task_updated updates existing task', async () => {
    setupFetch([makeTask({ id: 'u-1', title: 'Original' })]);
    const { result } = renderHook(() => useTaskBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tasks[0].title).toBe('Original');

    const updated = makeTask({ id: 'u-1', title: 'Updated via WS' });
    act(() => {
      listeners.forEach((l) => l({ type: 'task_updated', task: updated }));
    });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0].title).toBe('Updated via WS');
  });

  it('WS task_updated inserts child under existing parent', async () => {
    setupFetch([makeTask({ id: 'parent-1', title: 'Parent' })]);
    const { result } = renderHook(() => useTaskBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tasks).toHaveLength(1);

    const child = makeTask({
      id: 'child-1',
      parentId: 'parent-1',
      title: 'Child via WS',
      depth: 1,
    });
    act(() => {
      listeners.forEach((l) => l({ type: 'task_updated', task: child }));
    });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0].children).toHaveLength(1);
    expect(result.current.tasks[0].children[0].title).toBe('Child via WS');
  });

  it('WS task_deleted removes task', async () => {
    setupFetch([makeTask({ id: 'del-1' }), makeTask({ id: 'del-2' })]);
    const { result } = renderHook(() => useTaskBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tasks).toHaveLength(2);

    act(() => {
      listeners.forEach((l) => l({ type: 'task_deleted', taskId: 'del-1' }));
    });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0].id).toBe('del-2');
  });

  it('refresh triggers refetch', async () => {
    const { result } = renderHook(() => useTaskBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    taskResponse = { tasks: [makeTask({ id: 'refreshed' })] };

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.tasks[0]?.id).toBe('refreshed'));
  });

  it('handles fetch error gracefully', async () => {
    fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/loop/status') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(defaultLoopStatus),
        });
      }
      return Promise.reject(new Error('Network error'));
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useTaskBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tasks).toEqual([]);
  });

  it('createTask throws on non-ok response', async () => {
    const { result } = renderHook(() => useTaskBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mutationResponses.push({ ok: false, status: 500 });

    await expect(act(() => result.current.createTask({ title: 'Fail' }))).rejects.toThrow(
      'Create task failed: 500',
    );
  });

  it('updateTask throws on non-ok response', async () => {
    setupFetch([makeTask()]);
    const { result } = renderHook(() => useTaskBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mutationResponses.push({ ok: false, status: 404 });

    await expect(act(() => result.current.updateTask('task-1', { title: 'Nope' }))).rejects.toThrow(
      'Update task failed: 404',
    );
  });

  it('deleteTask throws on non-ok response', async () => {
    setupFetch([makeTask()]);
    const { result } = renderHook(() => useTaskBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mutationResponses.push({ ok: false, status: 403 });

    await expect(act(() => result.current.deleteTask('task-1'))).rejects.toThrow(
      'Delete task failed: 403',
    );
  });

  it('WS loop_status updates loop state', async () => {
    const { result } = renderHook(() => useTaskBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.loopStatus.state).toBe('idle');

    act(() => {
      listeners.forEach((l) =>
        l({
          type: 'loop_status',
          state: 'running',
          goalId: 'g-1',
          activeTaskId: 't-1',
          progress: { done: 1, total: 3 },
          specMode: false,
          awaitingApproval: false,
        }),
      );
    });

    expect(result.current.loopStatus.state).toBe('running');
    expect(result.current.loopStatus.goalId).toBe('g-1');
    expect(result.current.loopStatus.progress).toEqual({ done: 1, total: 3 });
  });
});

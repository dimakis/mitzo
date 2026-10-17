// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../../lib/rename-session', () => ({
  renameSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
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
import { useSessionList } from '../useSessionList';
import { renameSession } from '../../lib/rename-session';
import { eventBus } from '../../lib/event-bus-singleton';

beforeEach(() => {
  window.dispatchEvent(new Event('mitzo:auth-lost'));
  vi.mocked(apiFetch).mockReset();

  // Default: all fetches succeed with empty data
  vi.mocked(apiFetch).mockImplementation((url: string) => {
    if (url === '/api/sessions')
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) }) as Promise<Response>;
    if (url === '/api/config')
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
    if (url === '/api/version')
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useSessionList', () => {
  it('keeps unchanged activity snapshots and rows stable across repeated broadcasts', async () => {
    const sessions = [
      { id: 'one', isActive: true, isAttached: true },
      { id: 'two', isActive: false, isAttached: false },
    ];
    vi.mocked(apiFetch).mockImplementation(
      async (url) => new Response(JSON.stringify(url === '/api/sessions' ? sessions : {})),
    );
    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const onActivity = vi
      .mocked(eventBus.on)
      .mock.calls.filter(([name]) => name === 'session_activity')
      .at(-1)![1];
    const initial = result.current.sessions;
    act(() => onActivity([{ sessionId: 'one', state: 'working' }]));
    expect(result.current.sessions).toBe(initial);
    act(() => onActivity([{ sessionId: 'one', state: 'done' }]));
    expect(result.current.sessions).not.toBe(initial);
    expect(result.current.sessions[0]).toEqual({ id: 'one', isActive: true, isAttached: false });
    expect(result.current.sessions[1]).toBe(initial[1]);
    const finished = result.current.sessions;
    act(() => onActivity([{ sessionId: 'one', state: 'done' }]));
    expect(result.current.sessions).toBe(finished);
  });

  it('starts in loading state', () => {
    const { result } = renderHook(() => useSessionList());
    expect(result.current.loading).toBe(true);
  });

  it('fetches sessions on mount', async () => {
    const sessions = [{ id: 'abc', summary: 'Test', lastModified: Date.now() }];
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (url === '/api/sessions')
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(sessions),
        }) as Promise<Response>;
      if (url === '/api/config')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
      if (url === '/api/version')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
    });

    const { result } = renderHook(() => useSessionList());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sessions).toEqual(sessions);
    expect(result.current.error).toBeNull();
  });

  it('keeps a failed session request distinct from an empty session list and retries it', async () => {
    let available = false;
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (url === '/api/sessions') {
        return Promise.resolve(
          available
            ? ({ ok: true, json: () => Promise.resolve([]) } as Response)
            : ({
                ok: false,
                status: 503,
                json: () => Promise.resolve({ error: 'offline' }),
              } as Response),
        );
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
    });
    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toEqual([]);
    expect(result.current.error).toBe('Couldn’t load chats. Check the connection and try again.');

    available = true;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it('clears a load-more error when a later page succeeds', async () => {
    let moreAttempts = 0;
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (url === '/api/sessions') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sessions: [{ id: 'first' }], hasMore: true }),
        }) as Promise<Response>;
      }
      if (url === '/api/sessions?offset=1') {
        moreAttempts += 1;
        return Promise.resolve(
          moreAttempts === 1
            ? ({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response)
            : ({
                ok: true,
                json: () => Promise.resolve({ sessions: [{ id: 'second' }], hasMore: false }),
              } as Response),
        );
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
    });
    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).toContain('Couldn’t load more chats'));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.sessions.map((session) => session.id)).toEqual(['first', 'second']);
  });

  it.each([
    { sessions: [] },
    { sessions: [{ id: 'saved', summary: 'Already loaded', lastModified: 1 }] },
  ])(
    'reports a refresh failure after a successful load and preserves its list: %j',
    async ({ sessions }) => {
      vi.mocked(apiFetch).mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(url === '/api/sessions' ? sessions : {}),
        } as Response),
      );
      const { result } = renderHook(() => useSessionList());
      await waitFor(() => expect(result.current.loading).toBe(false));

      vi.mocked(apiFetch).mockRejectedValue(new Error('Offline'));
      act(() => result.current.retry());
      await waitFor(() =>
        expect(result.current.error).toBe('Couldn’t refresh chats. Showing the last loaded list.'),
      );
      expect(result.current.sessions).toEqual(sessions);

      vi.mocked(apiFetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ id: 'new', summary: 'Updated', lastModified: 2 }]),
      } as Response);
      act(() => result.current.retry());
      await waitFor(() => expect(result.current.error).toBeNull());
      expect(result.current.sessions[0].id).toBe('new');
    },
  );

  it('reports revalidation of a cached list as a refresh failure on remount', async () => {
    const sessions = [{ id: 'cached', summary: 'Cached chat', lastModified: 1 }];
    vi.mocked(apiFetch).mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(url === '/api/sessions' ? sessions : {}),
      } as Response),
    );
    const first = renderHook(() => useSessionList());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    vi.mocked(apiFetch).mockRejectedValue(new Error('Offline'));
    const next = renderHook(() => useSessionList());
    expect(next.result.current.sessions).toEqual(sessions);
    await waitFor(() =>
      expect(next.result.current.error).toBe(
        'Couldn’t refresh chats. Showing the last loaded list.',
      ),
    );
  });

  it('dismissSession removes from list and calls DELETE', async () => {
    const sessions = [
      { id: 'a', summary: 'A', lastModified: Date.now() },
      { id: 'b', summary: 'B', lastModified: Date.now() },
    ];
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (url === '/api/sessions')
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(sessions),
        }) as Promise<Response>;
      if (url === '/api/config')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
      if (url === '/api/version')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
    });

    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      result.current.dismissSession('a');
    });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].id).toBe('b');
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/a', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  });

  it('clearAll empties sessions and calls DELETE', async () => {
    const sessions = [{ id: 'a', summary: 'A', lastModified: Date.now() }];
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (url === '/api/sessions')
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(sessions),
        }) as Promise<Response>;
      if (url === '/api/config')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
      if (url === '/api/version')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
    });

    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      result.current.clearAll();
    });

    expect(result.current.sessions).toHaveLength(0);
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions', { method: 'DELETE' });
  });

  it('handleRename does optimistic update', async () => {
    const sessions = [{ id: 'a', summary: 'Old', lastModified: Date.now() }];
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (url === '/api/sessions')
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(sessions),
        }) as Promise<Response>;
      if (url === '/api/config')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
      if (url === '/api/version')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
    });

    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.handleRename('a', 'New Name');
    });

    expect(result.current.sessions[0].summary).toBe('New Name');
  });

  it('builds quick actions from config', async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (url === '/api/sessions')
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) }) as Promise<Response>;
      if (url === '/api/config')
        return Promise.resolve({
          json: () => Promise.resolve({ quickActions: [{ label: 'Test', desc: 'Test action' }] }),
        }) as Promise<Response>;
      if (url === '/api/version')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
    });

    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.quickActions).toHaveLength(3); // Chat + server action + Files
    expect(result.current.quickActions[1].label).toBe('Test');
  });
});

it.each([
  ['delete', 'network'],
  ['delete', 'http'],
  ['clear', 'network'],
  ['clear', 'http'],
] as const)('preserves sessions and pagination when %s fails with %s', async (action, failure) => {
  const sessions = [
    { id: 'a', summary: 'A', lastModified: 2 },
    { id: 'b', summary: 'B', lastModified: 1 },
  ];
  let rejectDelete!: (error: Error) => void;
  let resolveDelete!: (response: Response) => void;
  const deletion = new Promise<Response>((resolve, reject) => {
    resolveDelete = resolve;
    rejectDelete = reject;
  });
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'DELETE') return deletion;
    if (url === '/api/sessions') return Response.json({ sessions, hasMore: true });
    return Response.json({});
  });
  const { result } = renderHook(() => useSessionList());
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => {
    if (action === 'delete') result.current.dismissSession('a');
    else result.current.clearAll();
    if (failure === 'network') rejectDelete(new Error('offline'));
    else resolveDelete(Response.json({ error: 'unavailable' }, { status: 503 }));
  });
  expect(result.current.sessions).toEqual(sessions);
  expect(result.current.hasMore).toBe(true);
  act(() => result.current.loadMore());
  expect(apiFetch).toHaveBeenCalledWith('/api/sessions?offset=2');
});

it('finishes loading chats while configuration and version requests are still pending', async () => {
  vi.mocked(apiFetch).mockImplementation((url) =>
    url === '/api/sessions'
      ? Promise.resolve(
          Response.json({
            sessions: [{ id: 'ready', summary: 'Ready', lastModified: 1 }],
            hasMore: false,
          }),
        )
      : new Promise<Response>(() => {}),
  );
  const { result } = renderHook(() => useSessionList());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.sessions[0].id).toBe('ready');
});

it('retains chats immediately on remount while revalidating and deduplicates concurrent refreshes', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    Response.json(
      url === '/api/sessions'
        ? { sessions: [{ id: 'cached', summary: 'Cached', lastModified: 1 }], hasMore: false }
        : {},
    ),
  );
  const first = renderHook(() => useSessionList());
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  first.unmount();
  vi.mocked(apiFetch).mockClear();
  let finish!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation((url) =>
    url === '/api/sessions'
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(Response.json({})),
  );
  const second = renderHook(() => useSessionList());
  const third = renderHook(() => useSessionList());
  expect(second.result.current.loading).toBe(false);
  expect(second.result.current.sessions[0].id).toBe('cached');
  expect(apiFetch).toHaveBeenCalledTimes(5); // one shared sessions request, config/version per mount
  await act(async () => finish(Response.json({ sessions: [{ id: 'fresh' }], hasMore: false })));
  await waitFor(() => expect(second.result.current.sessions[0].id).toBe('fresh'));
  expect(third.result.current.sessions[0].id).toBe('fresh');
});

it('retains the recovered server title after a rejected rename and remount', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    Response.json(
      url === '/api/sessions'
        ? { sessions: [{ id: 'a', summary: 'Original', lastModified: 1 }], hasMore: false }
        : {},
    ),
  );
  const first = renderHook(() => useSessionList());
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  vi.mocked(renameSession).mockRejectedValueOnce(new Error('rejected'));
  await act(async () => first.result.current.handleRename('a', 'Rejected'));
  await waitFor(() => expect(first.result.current.sessions[0].summary).toBe('Original'));
  first.unmount();
  vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>(() => {}));
  const restored = renderHook(() => useSessionList());
  expect(restored.result.current.sessions[0].summary).toBe('Original');
});

it.each([true, false])(
  'removes a deleted conversation pin only after a successful deletion (%s)',
  async (ok) => {
    localStorage.setItem(
      'mitzo-conversation-pins',
      JSON.stringify([{ id: 'a', summary: 'A', lastModified: 1 }]),
    );
    vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
      Response.json(init?.method === 'DELETE' ? {} : [], {
        status: init?.method === 'DELETE' && !ok ? 503 : 200,
      }),
    );
    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => result.current.dismissSession('a'));
    expect(JSON.parse(localStorage.getItem('mitzo-conversation-pins')!)).toHaveLength(ok ? 0 : 1);
    localStorage.removeItem('mitzo-conversation-pins');
  },
);

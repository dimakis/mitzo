// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useConversationJoiningSourceSetup } from '../useConversationJoiningSourceSetup';
import * as auth from '../../lib/api-fetch';

const originalBase = import.meta.env.VITE_API_BASE_URL;
const props = { sourceConversationId: 'source-chat', clientId: 'live-client' };
const group = '00000000-0000-4000-8000-000000000010';
const selected = (sourceConversationId = 'source-chat', revision = 1) => ({
  state: 'selected',
  sourceConversationId,
  collaboration: {
    version: 1,
    collaborationId: group,
    revision,
    participantSessionIds: [sourceConversationId],
  },
});
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function transport(read: (source: string) => Promise<Response> | Response) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'https://offline.test');
    if (url.pathname === '/api/auth/check')
      return Response.json({ ok: true, authSessionId: 'source-setup-login' });
    expect(url.pathname).toBe('/api/session-collaborations/source-setup');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.credentials).toBe('include');
    expect(url.searchParams.get('clientId')).toBeTruthy();
    return read(url.searchParams.get('sourceConversationId')!);
  });
}
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  auth.markAuthLost();
  vi.stubGlobal(
    'fetch',
    transport((source) => Response.json({ state: 'unstarted', sourceConversationId: source })),
  );
  await auth.restoreCookieAuthentication();
  vi.mocked(fetch).mockClear();
});
afterEach(() => {
  cleanup();
  import.meta.env.VITE_API_BASE_URL = originalBase;
  vi.unstubAllGlobals();
});

it('reads the genuine typed source-setup port without beginning a group, and requires a live client', async () => {
  const hook = renderHook((input) => useConversationJoiningSourceSetup(input), {
    initialProps: { ...props, clientId: null as string | null | undefined },
  });
  expect(fetch).not.toHaveBeenCalled();
  hook.rerender(props);
  await waitFor(() => expect(hook.result.current.sourceSetup?.state).toBe('unstarted'));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(hook.result.current.canRefresh).toBe(false);
  expect(hook.result.current).not.toHaveProperty('joiningOwner');
});

it('projects only the canonical selected result rather than selecting an association from a list', async () => {
  vi.stubGlobal(
    'fetch',
    transport(() => Response.json(selected())),
  );
  const hook = renderHook(() => useConversationJoiningSourceSetup(props));
  await waitFor(() => expect(hook.result.current.sourceSetup).toEqual(selected()));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(hook.result.current.reason).toBeUndefined();
});

it.each(['multiple_associations', 'origin_unverified', 'foreign_origin'] as const)(
  'retains the server refusal %s without creating or substituting a group',
  async (reason) => {
    const value = { state: 'unavailable', sourceConversationId: 'source-chat', reason };
    vi.stubGlobal(
      'fetch',
      transport(() => Response.json(value)),
    );
    const hook = renderHook(() => useConversationJoiningSourceSetup(props));
    await waitFor(() => expect(hook.result.current.sourceSetup).toEqual(value));
    expect(hook.result.current.reason).toBeTruthy();
    expect(hook.result.current.canRefresh).toBe(true);
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.sourceSetup).toEqual(value);
  },
);

it('reports read failure and retries only the same observational port', async () => {
  let fail = true;
  vi.stubGlobal(
    'fetch',
    transport((source) =>
      fail
        ? Response.json({ error: 'Unavailable', code: 'unavailable' }, { status: 503 })
        : Response.json({ state: 'unstarted', sourceConversationId: source }),
    ),
  );
  const hook = renderHook(() => useConversationJoiningSourceSetup(props));
  await waitFor(() => expect(hook.result.current.canRefresh).toBe(true));
  expect(hook.result.current.sourceSetup).toBeNull();
  fail = false;
  act(() => hook.result.current.refresh());
  await waitFor(() => expect(hook.result.current.sourceSetup?.state).toBe('unstarted'));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('refuses a response for a foreign source through the real client schema', async () => {
  vi.stubGlobal(
    'fetch',
    transport(() => Response.json(selected('foreign-chat'))),
  );
  const hook = renderHook(() => useConversationJoiningSourceSetup(props));
  await waitFor(() => expect(hook.result.current.canRefresh).toBe(true));
  expect(hook.result.current.sourceSetup).toBeNull();
});

it.each(['source', 'client', 'base'] as const)(
  'fences a late completion across a %s change and return',
  async (change) => {
    const old = deferred();
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      transport((source) => (++reads === 1 ? old.promise : Response.json(selected(source, reads)))),
    );
    const hook = renderHook((input) => useConversationJoiningSourceSetup(input), {
      initialProps: props,
    });
    await waitFor(() => expect(reads).toBe(1));
    if (change === 'base') import.meta.env.VITE_API_BASE_URL = 'https://other.test';
    hook.rerender(
      change === 'source'
        ? { ...props, sourceConversationId: 'second-chat' }
        : change === 'client'
          ? { ...props, clientId: 'second-client' }
          : { ...props },
    );
    await waitFor(() =>
      expect(hook.result.current.sourceSetup).toEqual(
        selected(change === 'source' ? 'second-chat' : 'source-chat', 2),
      ),
    );
    import.meta.env.VITE_API_BASE_URL = originalBase;
    hook.rerender({ ...props });
    await waitFor(() =>
      expect(hook.result.current.sourceSetup).toEqual(selected('source-chat', 3)),
    );
    await act(async () => {
      old.resolve(Response.json(selected('source-chat', 1)));
    });
    expect(hook.result.current.sourceSetup).toEqual(selected('source-chat', 3));
  },
);

it('clears private selection on auth loss and re-reads after same-login restoration before publishing', async () => {
  const old = deferred(),
    restored = deferred();
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    transport(() =>
      ++reads === 1 ? Response.json(selected()) : reads === 2 ? old.promise : restored.promise,
    ),
  );
  const hook = renderHook(() => useConversationJoiningSourceSetup(props));
  await waitFor(() => expect(hook.result.current.sourceSetup).toEqual(selected()));
  act(() => hook.result.current.refresh());
  await waitFor(() => expect(reads).toBe(2));
  act(() => auth.markAuthLost());
  expect(hook.result.current.sourceSetup).toBeNull();
  await act(async () => {
    old.resolve(Response.json(selected('source-chat', 2)));
  });
  expect(hook.result.current.sourceSetup).toBeNull();
  await act(async () => {
    await auth.restoreCookieAuthentication();
  });
  await waitFor(() => expect(reads).toBe(3));
  expect(hook.result.current.sourceSetup).toBeNull();
  await act(async () => {
    restored.resolve(Response.json(selected('source-chat', 3)));
  });
  await waitFor(() => expect(hook.result.current.sourceSetup).toEqual(selected('source-chat', 3)));
});

it('aborts the read when its page unmounts even if transport later returns', async () => {
  const pending = deferred();
  vi.stubGlobal(
    'fetch',
    transport(() => pending.promise),
  );
  const hook = renderHook(() => useConversationJoiningSourceSetup(props));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
  hook.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    pending.resolve(Response.json(selected()));
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

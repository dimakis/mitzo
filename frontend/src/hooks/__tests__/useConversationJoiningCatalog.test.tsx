// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CollaborationSourceCatalog } from '@mitzo/protocol';
import { useConversationJoiningCatalog } from '../useConversationJoiningCatalog';
import { joiningReviewFixture } from '../../preview/conversation-joining-fixture';
import {
  retainedArtifact,
  retainedPin,
} from '../../lib/__tests__/conversation-joining-retained-fixture';
import * as auth from '../../lib/api-fetch';

const originalBase = import.meta.env.VITE_API_BASE_URL;
const props = { sourceConversationId: 'source-chat', clientId: 'live-client' };
const cursor = { createdAt: '2026-10-20', artifactId: 'plan', revision: 2 };
function catalog(sourceConversationId = 'source-chat'): CollaborationSourceCatalog {
  const review = joiningReviewFixture();
  return {
    sourceConversationId,
    boundary: review.snapshot.boundary,
    messages: review.snapshot.messages.map((message) => ({
      ...message,
      conversationId: sourceConversationId,
    })),
    artifacts: [...review.artifactLabels!, structuredClone(retainedArtifact)],
    artifactCursor: null,
    artifactHasMore: false,
    retainedAvailability: 'available',
    unversionedRetainedReferences: false,
    sourceRepository: { repository: 'dimakis/mitzo' },
  };
}
function transport(
  read: (
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal | null,
  ) => Response | Promise<Response>,
) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'https://offline.invalid');
    if (url.pathname === '/api/auth/check')
      return Response.json({ ok: true, authSessionId: 'catalog-login' });
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect([
      '/api/session-collaborations/source-catalog',
      '/api/session-collaborations/source-artifact-versions',
    ]).toContain(url.pathname);
    const body = JSON.parse(init!.body as string);
    expect(body.clientId).toBeTruthy();
    return read(url.pathname, body, init?.signal);
  });
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  auth.markAuthLost();
  vi.stubGlobal(
    'fetch',
    transport((_path, body) => Response.json(catalog(body.sourceConversationId as string))),
  );
  await auth.restoreCookieAuthentication();
  vi.mocked(fetch).mockClear();
});
afterEach(() => {
  cleanup();
  import.meta.env.VITE_API_BASE_URL = originalBase;
  vi.unstubAllGlobals();
});

it('reads actual typed metadata only with a verified login and real interactive client', async () => {
  const hook = renderHook((input) => useConversationJoiningCatalog(input), {
    initialProps: { ...props, clientId: null as string | null },
  });
  expect(fetch).not.toHaveBeenCalled();
  hook.rerender(props);
  await waitFor(() => expect(hook.result.current.catalog).toEqual(catalog()));
  expect(hook.result.current.artifacts).toHaveLength(2);
  expect(hook.result.current.artifacts[1]).not.toHaveProperty('sourceConversationId');
  expect(hook.result.current).not.toHaveProperty('joiningOwner');
  expect(sessionStorage.length).toBe(0);
});

it('preserves honest missing repository and retained access metadata without manufacturing joining capability', async () => {
  const value = catalog();
  value.sourceRepository = null;
  value.artifacts = [value.artifacts[0]];
  value.retainedAvailability = 'unavailable';
  value.unversionedRetainedReferences = true;
  vi.stubGlobal(
    'fetch',
    transport(() => Response.json(value)),
  );
  const hook = renderHook(() => useConversationJoiningCatalog(props));
  await waitFor(() => expect(hook.result.current.catalog).toEqual(value));
  expect(hook.result.current).not.toHaveProperty('joiningOwner');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sessionStorage.length).toBe(0);
});

it('rejects a retired action callback immediately on same-ID auth restoration before React rerenders', async () => {
  vi.stubGlobal(
    'fetch',
    transport(() => Response.json({ ...catalog(), artifactCursor: cursor, artifactHasMore: true })),
  );
  const hook = renderHook(() => useConversationJoiningCatalog(props));
  await waitFor(() => expect(hook.result.current.hasMore).toBe(true));
  const old = hook.result.current.loadMore;
  const count = vi.mocked(fetch).mock.calls.length;
  act(() => {
    window.dispatchEvent(new Event(auth.AUTH_RESTORED_EVENT));
    void old();
    expect(fetch).toHaveBeenCalledTimes(count);
  });
  await waitFor(() => expect(hook.result.current.catalog).not.toBeNull());
});

it('merges origin pages by exact kind and pin while deduplicating repeated inline metadata', async () => {
  const first = { ...catalog(), artifactCursor: cursor, artifactHasMore: true };
  vi.stubGlobal(
    'fetch',
    transport((_path, body) => {
      if (!body.artifactsAfter) return Response.json(first);
      expect(body.artifactsAfter).toEqual(cursor);
      const page = catalog();
      page.artifacts = [page.artifacts[0], { ...retainedArtifact, artifactId: 'second' }];
      return Response.json(page);
    }),
  );
  const hook = renderHook(() => useConversationJoiningCatalog(props));
  await waitFor(() => expect(hook.result.current.hasMore).toBe(true));
  await act(() => hook.result.current.loadMore());
  expect(hook.result.current.hasMore).toBe(false);
  expect(
    hook.result.current.artifacts.map((a) => [a.artifactId, 'kind' in a ? a.kind : 'inline']),
  ).toEqual([
    ['plan', 'inline'],
    ['plan', 'retainedArtifactVersion'],
    ['second', 'retainedArtifactVersion'],
  ]);
});

it.each(['boundary', 'repository', 'metadata', 'hash', 'cursor'] as const)(
  'refuses a changed %s while retaining exact previously observed options',
  async (change) => {
    const first = { ...catalog(), artifactCursor: cursor, artifactHasMore: true };
    vi.stubGlobal(
      'fetch',
      transport((_path, body) => {
        if (!body.artifactsAfter) return Response.json(first);
        const page = catalog();
        if (change === 'boundary') {
          page.boundary = { sequence: 9, messageId: 'message-two' };
          page.messages.push({ ...page.messages[0], sequence: 9, messageId: 'message-two' });
        }
        if (change === 'repository') page.sourceRepository = { repository: 'other/repo' };
        if (change === 'metadata') page.artifacts[1].title = 'Changed same pin';
        if (change === 'hash') page.artifacts[1].sha256 = 'a'.repeat(64);
        if (change === 'cursor') {
          page.artifactCursor = cursor;
          page.artifactHasMore = true;
        }
        return Response.json(page);
      }),
    );
    const hook = renderHook(() => useConversationJoiningCatalog(props));
    await waitFor(() => expect(hook.result.current.hasMore).toBe(true));
    await act(() => hook.result.current.loadMore());
    expect(hook.result.current.reason).toBeTruthy();
    expect(hook.result.current.artifacts).toEqual(first.artifacts);
    expect(hook.result.current.pending).toBe(false);
  },
);

it('loads exact associated retained history through bounded typed pages without promoting a latest version', async () => {
  vi.stubGlobal(
    'fetch',
    transport((path, body) => {
      if (path.endsWith('/source-catalog')) return Response.json(catalog());
      expect(body.boundary).toEqual(catalog().boundary);
      expect(body.artifact).toEqual(retainedPin());
      expect(body.limit).toBe(50);
      return Response.json({
        sourceConversationId: 'source-chat',
        boundary: catalog().boundary,
        artifacts: [
          { ...retainedArtifact, revision: 1, sha256: 'a'.repeat(64), filename: 'plan-r1.md' },
        ],
        cursor: null,
        hasMore: false,
      });
    }),
  );
  const hook = renderHook(() => useConversationJoiningCatalog(props));
  await waitFor(() => expect(hook.result.current.artifacts).toHaveLength(2));
  await act(() => hook.result.current.loadEarlier(retainedPin()));
  expect(hook.result.current.artifacts[1]).toEqual(retainedArtifact);
  expect(hook.result.current.artifacts[2]).toMatchObject({
    kind: 'retainedArtifactVersion',
    revision: 1,
    filename: 'plan-r1.md',
  });
  expect(hook.result.current.hasEarlier(retainedPin())).toBe(false);
  const count = vi.mocked(fetch).mock.calls.length;
  await act(() => hook.result.current.loadEarlier(retainedPin()));
  expect(fetch).toHaveBeenCalledTimes(count);
});

it('serializes history pagination and retains exact options when the next history response is refused', async () => {
  const old = deferred();
  vi.stubGlobal(
    'fetch',
    transport((path) =>
      path.endsWith('/source-catalog') ? Response.json(catalog()) : old.promise,
    ),
  );
  const hook = renderHook(() => useConversationJoiningCatalog(props));
  await waitFor(() => expect(hook.result.current.artifacts).toHaveLength(2));
  let pending!: Promise<void>;
  act(() => {
    pending = hook.result.current.loadEarlier(retainedPin());
    void hook.result.current.loadEarlier(retainedPin());
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => {
    old.resolve(Response.json({ error: 'Unavailable' }, { status: 503 }));
    await pending;
  });
  expect(hook.result.current.artifacts).toEqual(catalog().artifacts);
  expect(hook.result.current.reason).toBeTruthy();
});

it('retires an in-flight page immediately on explicit refresh and refuses its old action callback', async () => {
  const old = deferred();
  vi.stubGlobal(
    'fetch',
    transport((_path, body) =>
      body.artifactsAfter
        ? old.promise
        : Response.json({ ...catalog(), artifactCursor: cursor, artifactHasMore: true }),
    ),
  );
  const hook = renderHook(() => useConversationJoiningCatalog(props));
  await waitFor(() => expect(hook.result.current.hasMore).toBe(true));
  let pending!: Promise<void>;
  act(() => {
    pending = hook.result.current.loadMore();
  });
  const retiredAction = hook.result.current.loadMore;
  const count = vi.mocked(fetch).mock.calls.length;
  act(() => {
    hook.result.current.refresh();
    void retiredAction();
    expect(fetch).toHaveBeenCalledTimes(count);
  });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(count + 1));
  await act(async () => {
    const page = catalog();
    page.sourceRepository = { repository: 'stale/repo' };
    old.resolve(Response.json(page));
    await pending;
  });
  expect(hook.result.current.catalog?.sourceRepository?.repository).toBe('dimakis/mitzo');
});

it.each(['source', 'base', 'client'] as const)(
  'fences a late catalog through a %s A-B-A cycle',
  async (change) => {
    const old = deferred();
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      transport((_path, body) => {
        if (++calls === 1) return old.promise;
        const data = catalog(body.sourceConversationId as string);
        data.sourceRepository = { repository: 'fresh/current' };
        return Response.json(data);
      }),
    );
    const hook = renderHook((input) => useConversationJoiningCatalog(input), {
      initialProps: props,
    });
    await waitFor(() => expect(calls).toBe(1));
    if (change === 'base') import.meta.env.VITE_API_BASE_URL = 'https://other-offline.invalid';
    hook.rerender({
      ...props,
      sourceConversationId: change === 'source' ? 'other-chat' : 'source-chat',
      clientId: change === 'client' ? 'another-client' : 'live-client',
    });
    await waitFor(() => expect(calls).toBe(2));
    import.meta.env.VITE_API_BASE_URL = originalBase;
    hook.rerender(props);
    await waitFor(() => expect(calls).toBe(3));
    await waitFor(() =>
      expect(hook.result.current.catalog?.sourceRepository?.repository).toBe('fresh/current'),
    );
    await act(async () => old.resolve(Response.json(catalog())));
    expect(hook.result.current.catalog?.sourceRepository?.repository).toBe('fresh/current');
  },
);

it('retires private catalog and late history when the same login is lost and restored', async () => {
  const old = deferred();
  vi.stubGlobal(
    'fetch',
    transport((path) =>
      path.endsWith('/source-artifact-versions') ? old.promise : Response.json(catalog()),
    ),
  );
  const hook = renderHook(() => useConversationJoiningCatalog(props));
  await waitFor(() => expect(hook.result.current.artifacts).toHaveLength(2));
  let pending!: Promise<void>;
  act(() => {
    pending = hook.result.current.loadEarlier(retainedPin());
  });
  await act(async () => {
    auth.markAuthLost();
    await auth.restoreCookieAuthentication();
  });
  await waitFor(() => expect(hook.result.current.artifacts).toHaveLength(2));
  await act(async () => {
    old.resolve(
      Response.json({
        sourceConversationId: 'source-chat',
        boundary: catalog().boundary,
        artifacts: [{ ...retainedArtifact, revision: 1 }],
        cursor: null,
        hasMore: false,
      }),
    );
    await pending;
  });
  expect(hook.result.current.artifacts).toHaveLength(2);
});

it('aborts retired reads and does not publish after unmount even if the transport ignores abort', async () => {
  const old = deferred();
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal(
    'fetch',
    transport((_path, _body, captured) => {
      signal = captured;
      return old.promise;
    }),
  );
  const hook = renderHook(() => useConversationJoiningCatalog(props));
  await waitFor(() => expect(signal).toBeDefined());
  hook.unmount();
  expect(signal!.aborted).toBe(true);
  old.resolve(Response.json(catalog()));
});

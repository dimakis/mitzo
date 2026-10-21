// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MitzoApiClient } from '@mitzo/client';
import { resolveConversationJoiningSource as resolve } from '../conversation-joining-source-owner';
import { conversationJoiningRecovery } from '../conversation-joining-recovery';
import * as auth from '../api-fetch';

const sourceConversationId = 'source-chat';
const originalBase = import.meta.env.VITE_API_BASE_URL;
beforeEach(async () => {
  sessionStorage.clear();
  localStorage.clear();
  auth.markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'begin-login' })),
  );
  await auth.restoreCookieAuthentication();
});
afterEach(() => {
  import.meta.env.VITE_API_BASE_URL = originalBase;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function harness() {
  let group: string | null = null;
  let clientId: string | null = 'live-client';
  let current = true;
  let refuse: string | undefined;
  let lose: 'before' | 'after' | undefined;
  let reading: (() => Promise<void>) | undefined;
  let beginning: (() => void) | undefined;
  let conflict = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.credentials).toBe('include');
    const parsed = new URL(url, 'https://offline.invalid');
    if (parsed.pathname === '/api/session-collaborations/source-setup') {
      expect(init?.method ?? 'GET').toBe('GET');
      expect(parsed.searchParams.get('clientId')).toBe('live-client');
      expect(parsed.searchParams.get('sourceConversationId')).toBe(sourceConversationId);
      await reading?.();
      return Response.json(
        refuse
          ? { state: 'unavailable', sourceConversationId, reason: refuse }
          : group
            ? { state: 'selected', sourceConversationId, collaboration: membership(group) }
            : { state: 'unstarted', sourceConversationId },
      );
    }
    const match = parsed.pathname.match(/^\/api\/session-collaborations\/([^/]+)\/begin$/);
    expect(match).not.toBeNull();
    expect(init?.method).toBe('POST');
    const input = JSON.parse(init!.body as string);
    const retained = conversationJoiningRecovery(sourceConversationId).readBegin();
    // The real typed request crosses HTTP only after the original IDs are stored.
    expect(retained).toEqual({ collaborationId: match![1], requestId: input.requestId });
    expect(input.sessionId).toBe(sourceConversationId);
    expect(conversationJoiningRecovery(sourceConversationId).read()).toBeNull();
    if (conflict) return Response.json({ error: 'Conflict', code: 'conflict' }, { status: 409 });
    if (lose === 'before') {
      lose = undefined;
      throw Error('Transport failed before response');
    }
    group = match![1];
    beginning?.();
    if (lose === 'after') {
      lose = undefined;
      throw Error('Committed response lost');
    }
    return Response.json(membership(group));
  });
  const options = {
    api: new MitzoApiClient(fetch),
    sourceConversationId,
    getClientId: () => clientId,
    isCurrent: () => current,
    signal: new AbortController().signal,
  };
  return {
    options,
    fetch,
    select: (value: string) => {
      group = value;
    },
    refuse: (value: string) => {
      refuse = value;
    },
    lose: (value: typeof lose) => {
      lose = value;
    },
    reading: (callback: typeof reading) => {
      reading = callback;
    },
    beginning: (callback: typeof beginning) => {
      beginning = callback;
    },
    conflict: (value: boolean) => {
      conflict = value;
    },
    client: (value: typeof clientId) => {
      clientId = value;
    },
    retire: () => {
      current = false;
    },
    posts: () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST'),
  };
}
function membership(collaborationId: string) {
  return {
    version: 1,
    collaborationId,
    revision: 1,
    participantSessionIds: [sourceConversationId],
  };
}

it('retains original begin IDs before an explicit first Add POST and returns only a fresh canonical selection', async () => {
  const h = harness();
  expect(h.fetch).not.toHaveBeenCalled();
  expect(sessionStorage.length).toBe(0);
  const result = await resolve(h.options);
  const retained = conversationJoiningRecovery(sourceConversationId).readBegin()!;
  expect(result).toEqual({
    state: 'selected',
    sourceConversationId,
    collaboration: membership(retained.collaborationId),
  });
  expect(h.fetch).toHaveBeenCalledTimes(3);
  expect(h.posts()).toHaveLength(1);
  expect(retained.collaborationId).not.toBe(retained.requestId);
  expect(conversationJoiningRecovery(sourceConversationId).read()).toBeNull();
  const raw = sessionStorage.getItem(sessionStorage.key(0)!)!;
  expect(JSON.parse(raw)).toEqual({
    version: 3,
    sourceConversationId,
    begin: retained,
    review: null,
  });
  expect(raw).not.toMatch(/participantSessionIds|capacity|workspace|token|binding/);
});

it('uses a genuine selected association without creating or persisting another group', async () => {
  const h = harness();
  const id = '00000000-0000-4000-8000-000000000010';
  h.select(id);
  expect(await resolve(h.options)).toMatchObject({
    state: 'selected',
    collaboration: { collaborationId: id },
  });
  expect(h.posts()).toHaveLength(0);
  expect(sessionStorage.length).toBe(0);
});

it('requires an existing verified login before performing any source or begin request', async () => {
  const h = harness();
  auth.markAuthLost();
  await expect(resolve(h.options)).rejects.toThrow();
  expect(h.fetch).not.toHaveBeenCalled();
  expect(sessionStorage.length).toBe(0);
});

it('requires the current real interactive client before performing any source or begin request', async () => {
  const h = harness();
  h.client(null);
  await expect(resolve(h.options)).rejects.toThrow();
  expect(h.fetch).not.toHaveBeenCalled();
  expect(sessionStorage.length).toBe(0);
});

it.each(['multiple_associations', 'origin_unverified', 'foreign_origin'])(
  'returns the genuine %s refusal without selecting or creating a group',
  async (reason) => {
    const h = harness();
    h.refuse(reason);
    expect(await resolve(h.options)).toEqual({
      state: 'unavailable',
      sourceConversationId,
      reason,
    });
    expect(h.posts()).toHaveLength(0);
    expect(sessionStorage.length).toBe(0);
  },
);

it('recovers a committed lost begin response by canonical read after remount without a second POST', async () => {
  const h = harness();
  h.lose('after');
  await expect(resolve(h.options)).rejects.toThrow();
  const original = conversationJoiningRecovery(sourceConversationId).readBegin();
  const recovered = await resolve({ ...h.options });
  expect(recovered).toMatchObject({
    state: 'selected',
    collaboration: { collaborationId: original!.collaborationId },
  });
  expect(h.posts()).toHaveLength(1);
  expect(conversationJoiningRecovery(sourceConversationId).readBegin()).toEqual(original);
});

it('retries only the original IDs and body when the original begin is still unknown', async () => {
  const h = harness();
  h.lose('before');
  await expect(resolve(h.options)).rejects.toThrow();
  const original = conversationJoiningRecovery(sourceConversationId).readBegin();
  expect(await resolve({ ...h.options })).toMatchObject({ state: 'selected' });
  expect(h.posts()).toHaveLength(2);
  expect(h.posts()[1][0]).toBe(h.posts()[0][0]);
  expect(h.posts()[1][1]!.body).toBe(h.posts()[0][1]!.body);
  expect(conversationJoiningRecovery(sourceConversationId).readBegin()).toEqual(original);
});

it('refuses another selected group while the original begin remains uncertain', async () => {
  const h = harness();
  h.lose('before');
  await expect(resolve(h.options)).rejects.toThrow();
  const original = conversationJoiningRecovery(sourceConversationId).readBegin();
  h.select('00000000-0000-4000-8000-000000000099');
  await expect(resolve(h.options)).rejects.toThrow('original');
  expect(h.posts()).toHaveLength(1);
  expect(conversationJoiningRecovery(sourceConversationId).readBegin()).toEqual(original);
});

it('refuses a selected result when another explicit action retained begin identity during the read', async () => {
  const h = harness();
  h.select('00000000-0000-4000-8000-000000000099');
  h.reading(async () => {
    conversationJoiningRecovery(sourceConversationId).retainBegin(
      {
        collaborationId: '00000000-0000-4000-8000-000000000030',
        requestId: '00000000-0000-4000-8000-000000000031',
      },
      null,
    );
  });
  await expect(resolve(h.options)).rejects.toThrow();
  expect(h.posts()).toHaveLength(0);
  expect(conversationJoiningRecovery(sourceConversationId).readBegin()!.collaborationId).toBe(
    '00000000-0000-4000-8000-000000000030',
  );
});

it('does not POST when original begin correlation cannot be retained', async () => {
  const h = harness();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('Quota exceeded');
  });
  await expect(resolve(h.options)).rejects.toThrow();
  expect(h.posts()).toHaveLength(0);
  expect(h.fetch).toHaveBeenCalledTimes(1);
});

it('does not mint replacement IDs or retry automatically after a definite begin conflict', async () => {
  const h = harness();
  h.conflict(true);
  await expect(resolve(h.options)).rejects.toThrow();
  expect(h.fetch).toHaveBeenCalledTimes(2);
  const original = conversationJoiningRecovery(sourceConversationId).readBegin();
  await expect(resolve(h.options)).rejects.toThrow();
  expect(h.posts()).toHaveLength(2);
  expect(h.posts()[1][0]).toBe(h.posts()[0][0]);
  expect(h.posts()[1][1]!.body).toBe(h.posts()[0][1]!.body);
  expect(conversationJoiningRecovery(sourceConversationId).readBegin()).toEqual(original);
});

it('retains original IDs when a completed begin belongs to a retired source action', async () => {
  const h = harness();
  h.beginning(h.retire);
  await expect(resolve(h.options)).rejects.toThrow();
  const original = conversationJoiningRecovery(sourceConversationId).readBegin();
  expect(h.posts()).toHaveLength(1);
  const nextAction = { ...h.options, isCurrent: () => true };
  expect(await resolve(nextAction)).toMatchObject({ state: 'selected' });
  expect(h.posts()).toHaveLength(1);
  expect(conversationJoiningRecovery(sourceConversationId).readBegin()).toEqual(original);
});

it('preserves malformed uncertainty instead of overwriting it or beginning another group', async () => {
  const h = harness();
  conversationJoiningRecovery(sourceConversationId).retainBegin(
    {
      collaborationId: '00000000-0000-4000-8000-000000000030',
      requestId: '00000000-0000-4000-8000-000000000031',
    },
    null,
  );
  const key = sessionStorage.key(0)!;
  sessionStorage.setItem(key, '{broken');
  await expect(resolve(h.options)).rejects.toThrow();
  expect(h.fetch).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(key)).toBe('{broken');
});

it.each(['source', 'client', 'base', 'abort', 'auth'] as const)(
  'fences the explicit setup read across %s retirement before any begin POST',
  async (change) => {
    const h = harness();
    const controller = new AbortController();
    h.options.signal = controller.signal;
    h.reading(async () => {
      if (change === 'source') h.retire();
      if (change === 'client') h.client('another-client');
      if (change === 'base') import.meta.env.VITE_API_BASE_URL = 'https://other-offline.invalid';
      if (change === 'abort') controller.abort();
      if (change === 'auth') {
        auth.markAuthLost();
        await auth.restoreCookieAuthentication();
      }
    });
    await expect(resolve(h.options)).rejects.toThrow();
    expect(h.posts()).toHaveLength(0);
    expect(sessionStorage.length).toBe(0);
  },
);

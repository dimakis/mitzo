// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { CollaborationApiClient } from '@mitzo/client';
import { CollaborationPolicyUpdateSchema } from '@mitzo/protocol';
import type { CollaborationView } from '@mitzo/protocol';
import { createChatDraft, saveChatDraft, getChatDraft } from '../../lib/chat-drafts';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../../lib/api-fetch';
import { useConversationPresentation } from '../useConversationPresentation';
import {
  sharedConversationView,
  uuid,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function draft() {
  const saved = { ...createChatDraft(), text: 'Retain the ordinary draft' };
  saveChatDraft(saved);
  return saved;
}
function harness() {
  let current = sharedConversationView();
  let verified: string | undefined = 'verified-login';
  const saved = draft();
  const receipts = new Map<string, unknown>();
  const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/conversation')) return json(current);
    if (url.endsWith('/policy')) {
      const input = CollaborationPolicyUpdateSchema.parse(JSON.parse(String(init?.body)));
      if (receipts.has(input.requestId)) return json(receipts.get(input.requestId));
      const old = current.policies.find((p) => p.sessionId === input.sessionId)!;
      const policy = {
        ...old,
        revision: old.revision + 1,
        membershipRevision: current.membershipRevision,
        effectiveFromSequence: current.cursor + 2,
        readsFutureDiscussion: input.readsFutureDiscussion,
        repliesByDefault: input.repliesByDefault,
      };
      current = {
        ...current,
        cursor: current.cursor + 1,
        policySequence: current.cursor + 1,
        policies: current.policies.map((p) => (p.sessionId === input.sessionId ? policy : p)),
      };
      receipts.set(input.requestId, policy);
      return json(policy);
    }
    throw new Error(`Unexpected UI transport: ${url}`);
  });
  const api = new CollaborationApiClient(fetch);
  const proof = () => verified;
  return {
    api,
    fetch,
    saved,
    proof,
    get view() {
      return current;
    },
    set view(value: CollaborationView) {
      current = value;
    },
    set verified(value: string | undefined) {
      verified = value;
    },
    props: {
      collaborationId: current.collaborationId,
      api,
      authScope: 'verified-login',
      getVerifiedAuthScope: proof,
      draftId: saved.id,
    },
  };
}
async function loaded(h: ReturnType<typeof harness>) {
  const mounted = renderHook((props) => useConversationPresentation(props), {
    initialProps: h.props,
  });
  await waitFor(() => expect(mounted.result.current.projection?.view.cursor).toBe(h.view.cursor));
  return mounted;
}

it('binds real typed policy calls to confirmed server views without sending or optimistic policy changes', async () => {
  const h = harness();
  const { result } = await loaded(h);
  const send = vi.spyOn(h.api, 'send');
  expect(result.current.responderIntent).toEqual({ kind: 'default' });
  expect(result.current.resolvedResponderIds).toEqual(['architect']);
  expect(result.current.sendDisabledReason).toBe(h.view.execution.reason);
  await act(async () => {
    await result.current.setPolicy('architect', { reads: true, replies: false });
  });
  expect(result.current.projection?.view.policies[0]).toMatchObject({
    readsFutureDiscussion: true,
    repliesByDefault: false,
  });
  expect(result.current.responderIntent).toEqual({ kind: 'default' });
  expect(result.current.resolvedResponderIds).toEqual([]);
  const puts = h.fetch.mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(String(puts[0][1]?.body))).toMatchObject({
    expectedMembershipRevision: 1,
    expectedRevision: 0,
    sessionId: 'architect',
  });
  expect(send).not.toHaveBeenCalled();
});
it('restores exact selected[] after remount and retains unavailable selected IDs through a view refresh', async () => {
  const h = harness();
  const mounted = await loaded(h);
  act(() => {
    expect(mounted.result.current.setResponders({ kind: 'selected', sessionIds: [] })).toBe(true);
  });
  mounted.unmount();
  const { result } = await loaded(h);
  expect(result.current.responderIntent).toEqual({ kind: 'selected', sessionIds: [] });
  expect(result.current.resolvedResponderIds).toEqual([]);
  act(() => {
    result.current.setResponders({ kind: 'selected', sessionIds: ['reviewer', 'removed'] });
  });
  h.view = { ...h.view, unavailableParticipantSessionIds: ['reviewer'] };
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.resolvedResponderIds).toEqual(['reviewer', 'removed']);
  expect(result.current.recipientError).toMatch(/unavailable/i);
  expect(getChatDraft(h.saved.id)?.text).toBe(h.saved.text);
});
it('keeps an unchanged ordinary draft reference stable across its own save notification', async () => {
  const h = harness();
  const { result } = await loaded(h);
  const original = result.current.draft;
  act(() => {
    saveChatDraft({ ...getChatDraft(h.saved.id)!, updatedAt: Date.now() + 100 });
  });
  expect(result.current.draft).toBe(original);
});
it('does not replace recipient intent when ordinary draft storage refuses the write', async () => {
  const h = harness();
  const { result } = await loaded(h);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new Error('Storage full');
  });
  act(() => {
    expect(result.current.setResponders({ kind: 'selected', sessionIds: [] })).toBe(false);
  });
  expect(result.current.responderIntent).toEqual({ kind: 'default' });
  expect(result.current.draftError).toMatch(/Could not save/);
});
it('does not select another conversation’s retained recipient intent or overwrite its draft', async () => {
  const h = harness();
  saveChatDraft({
    ...h.saved,
    settings: {
      ...h.saved.settings,
      collaborationResponders: {
        collaborationId: uuid(999),
        responders: { kind: 'selected', sessionIds: ['private-agent'] },
      },
    },
  });
  const { result } = await loaded(h);
  expect(result.current.draft).toBeNull();
  expect(result.current.responderIntent).toBeNull();
  act(() => {
    expect(result.current.setResponders({ kind: 'all' })).toBe(false);
  });
  expect(getChatDraft(h.saved.id)?.settings.collaborationResponders?.collaborationId).toBe(
    uuid(999),
  );
});
it('disables reads and mutations without current proof from the existing auth owner', async () => {
  const h = harness();
  h.verified = undefined;
  const { result } = renderHook(() => useConversationPresentation(h.props));
  await act(async () => {
    await result.current.refresh();
    await result.current.setPolicy('architect', { reads: true, replies: true });
  });
  expect(result.current.projection).toBeNull();
  expect(result.current.draft).toBeNull();
  expect(h.fetch).not.toHaveBeenCalled();
  expect(result.current.error).toMatch(/Sign in/);
});
it('does not read merely because an auth scope string exists without the current owner getter', async () => {
  const h = harness();
  const { result } = renderHook(() =>
    useConversationPresentation({ ...h.props, getVerifiedAuthScope: undefined }),
  );
  await act(async () => {
    await result.current.refresh();
  });
  expect(h.fetch).not.toHaveBeenCalled();
  expect(result.current.projection).toBeNull();
});
it('clears private projection immediately on auth loss and rejects a late response', async () => {
  const h = harness();
  const { result } = await loaded(h);
  let resolve!: (value: Response) => void;
  h.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.refresh();
  });
  h.verified = undefined;
  act(() => {
    window.dispatchEvent(new Event(AUTH_LOST_EVENT));
  });
  expect(result.current.projection).toBeNull();
  expect(result.current.draft).toBeNull();
  await act(async () => {
    resolve(json(h.view));
    await pending;
  });
  expect(result.current.projection).toBeNull();
});
it('renews only after the existing auth owner completes its synchronous restore publication', async () => {
  const h = harness();
  const { result } = await loaded(h);
  h.verified = undefined;
  act(() => {
    window.dispatchEvent(new Event(AUTH_LOST_EVENT));
  });
  expect(result.current.projection).toBeNull();
  await act(async () => {
    // Existing api-fetch restores the latch before assigning its verified-cookie record.
    window.dispatchEvent(new Event(AUTH_RESTORED_EVENT));
    h.verified = 'verified-login';
  });
  await waitFor(() =>
    expect(result.current.projection?.view.collaborationId).toBe(h.view.collaborationId),
  );
});
it('reports an unavailable policy target without sending a mutation', async () => {
  const h = harness();
  h.view = { ...h.view, unavailableParticipantSessionIds: ['reviewer'] };
  const { result } = await loaded(h);
  await act(async () => {
    expect(await result.current.setPolicy('reviewer', { reads: true, replies: false })).toBe(false);
  });
  expect(result.current.policyError).toMatch(/unavailable/i);
  expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
});
it('rejects an older group read after switching to another conversation', async () => {
  const h = harness();
  let resolve!: (value: Response) => void;
  const old = h.view;
  h.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const { result, rerender } = renderHook((props) => useConversationPresentation(props), {
    initialProps: h.props,
  });
  h.view = { ...h.view, collaborationId: uuid(900), messages: [] };
  rerender({ ...h.props, collaborationId: uuid(900), draftId: draft().id });
  await waitFor(() => expect(result.current.projection?.view.collaborationId).toBe(uuid(900)));
  await act(async () => {
    resolve(json(old));
  });
  expect(result.current.projection?.view.messages).toEqual([]);
});
it('keeps the original uncertain policy request and retries its exact body', async () => {
  const h = harness();
  const { result } = await loaded(h);
  h.fetch.mockRejectedValueOnce(new TypeError('Response lost'));
  await act(async () => {
    await result.current.setPolicy('architect', { reads: true, replies: false });
  });
  const original = h.fetch.mock.calls.at(-1)![1]?.body;
  expect(result.current.pendingPolicy?.input).toEqual(JSON.parse(String(original)));
  await act(async () => {
    expect(await result.current.setPolicy('reader', { reads: false, replies: false })).toBe(false);
  });
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.pendingPolicy?.input).toEqual(JSON.parse(String(original)));
  await act(async () => {
    await result.current.retryPolicy();
  });
  const requests = h.fetch.mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(requests.map(([, init]) => init?.body)).toEqual([original, original]);
  expect(result.current.pendingPolicy).toBeNull();
  expect(result.current.projection?.view.policies[0].revision).toBe(1);
});
it('reconciles an uncertain policy only after a newer authoritative revision fences its old request', async () => {
  const h = harness();
  const { result } = await loaded(h);
  h.fetch.mockRejectedValueOnce(new TypeError('Response lost'));
  await act(async () => {
    await result.current.setPolicy('architect', { reads: true, replies: false });
  });
  h.view = {
    ...h.view,
    cursor: 3,
    policySequence: 3,
    policies: h.view.policies.map((p) =>
      p.sessionId === 'architect' ? { ...p, revision: 1, effectiveFromSequence: 4 } : p,
    ),
  };
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.pendingPolicy).toBeNull();
  expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
});
it('does not let a policy response from an old group publish or refresh the new group', async () => {
  const h = harness();
  const { result, rerender } = await loaded(h);
  let resolve!: (value: Response) => void;
  h.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  let pending!: Promise<boolean>;
  act(() => {
    pending = result.current.setPolicy('architect', { reads: true, replies: false });
  });
  const oldPolicy = { ...h.view.policies[0], revision: 1 };
  h.view = { ...h.view, collaborationId: uuid(900), messages: [] };
  rerender({ ...h.props, collaborationId: uuid(900), draftId: draft().id });
  await waitFor(() => expect(result.current.projection?.view.collaborationId).toBe(uuid(900)));
  const calls = h.fetch.mock.calls.length;
  await act(async () => {
    resolve(json(oldPolicy));
    await pending;
  });
  expect(h.fetch.mock.calls).toHaveLength(calls);
  expect(result.current.projection?.view.collaborationId).toBe(uuid(900));
  expect(result.current.pendingPolicy).toBeNull();
});
it('keeps conflicts explicit and does not retry a stale revision on refresh', async () => {
  const h = harness();
  const { result } = await loaded(h);
  h.fetch.mockResolvedValueOnce(json({ code: 'conflict', error: 'Membership changed' }, 409));
  await act(async () => {
    await result.current.setPolicy('architect', { reads: true, replies: false });
  });
  expect(result.current.policyError).toMatch(/Membership changed/);
  expect(result.current.pendingPolicy).toBeNull();
  await act(async () => {
    await result.current.refresh();
  });
  expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
});
it('retains the transcript on a replay gap and disables policy mutation until an authoritative refresh', async () => {
  const h = harness();
  const { result } = await loaded(h);
  h.fetch.mockResolvedValueOnce(
    json({ events: [], cursor: 99, highWatermark: 99, hasMore: false }),
  );
  await act(async () => {
    await result.current.refreshEvents();
  });
  expect(result.current.projection?.needsRefresh).toBe(true);
  expect(result.current.projection?.view.messages).toEqual(h.view.messages);
  await act(async () => {
    expect(await result.current.setPolicy('architect', { reads: true, replies: false })).toBe(
      false,
    );
  });
  expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
});
it('retains successful replies on refresh failure and rejects a view belonging to another group', async () => {
  const h = harness();
  const { result } = await loaded(h);
  h.fetch.mockRejectedValueOnce(new TypeError('Offline'));
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.projection?.view.messages).toEqual(h.view.messages);
  expect(result.current.error).toMatch(/Offline/);
  h.fetch.mockResolvedValueOnce(json({ ...h.view, collaborationId: uuid(999), messages: [] }));
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.projection?.view.collaborationId).toBe(h.view.collaborationId);
  expect(result.current.projection?.view.messages).toEqual(h.view.messages);
});

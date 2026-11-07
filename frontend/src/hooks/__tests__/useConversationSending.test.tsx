// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { CollaborationApiClient } from '@mitzo/client';
import { createChatDraft, getChatDraft, saveChatDraft } from '../../lib/chat-drafts';
import {
  sharedConversationView,
  sharedPrompt,
  uuid,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';
import { useConversationSending } from '../useConversationSending';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
it('requires server readiness and preserves one uncertain request across remount without resending', async () => {
  const view = sharedConversationView();
  const draft = createChatDraft();
  saveChatDraft({ ...draft, text: 'Keep this prompt' });
  let ready = false;
  const mutations: unknown[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/recipients/'))
      return Response.json({
        collaborationId: view.collaborationId,
        sessionId: 'reviewer',
        membershipRevision: view.membershipRevision,
        policySequence: view.policySequence,
        ready,
        reason: ready ? null : 'Review this participant.',
      });
    if (url.endsWith('/messages/observe')) return Response.json({ message: null });
    if (url.endsWith('/messages')) {
      mutations.push(JSON.parse(String(init?.body)));
      throw Error('Lost response');
    }
    throw Error('Unexpected request');
  });
  const api = new CollaborationApiClient(fetch);
  const proof = () => 'login';
  const props = {
    api,
    view,
    draftId: draft.id,
    authScope: 'login',
    getVerifiedAuthScope: proof,
    responders: { kind: 'selected' as const, sessionIds: ['reviewer'] },
    refresh: vi.fn(async () => {}),
  };
  const first = renderHook(() => useConversationSending(props));
  await waitFor(() => expect(first.result.current.disabledReason).toBe('Review this participant.'));
  await act(async () => {
    expect(await first.result.current.send('Keep this prompt')).toBe(false);
  });
  expect(mutations).toHaveLength(0);
  ready = true;
  await act(async () => {
    await first.result.current.check();
  });
  await waitFor(() => expect(first.result.current.disabledReason).toBeUndefined());
  await act(async () => {
    expect(await first.result.current.send('Keep this prompt')).toBe(false);
  });
  expect(mutations).toHaveLength(1);
  expect(getChatDraft(draft.id)?.text).toBe('Keep this prompt');
  first.unmount();
  const second = renderHook(() => useConversationSending(props));
  await waitFor(() => expect(second.result.current.disabledReason).toMatch(/original|uncertain/i));
  await act(async () => {
    await second.result.current.check();
  });
  await act(async () => {
    expect(await second.result.current.send('Changed retry')).toBe(false);
  });
  expect(mutations).toHaveLength(1);
});

it('checks a newly selected recipient while an older readiness request is still pending', async () => {
  const view = sharedConversationView();
  const draft = createChatDraft();
  saveChatDraft({ ...draft, text: 'Next prompt' });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi.fn(async (url: string) => {
    const old = url.endsWith('/reviewer');
    if (old) await held;
    return Response.json({
      collaborationId: view.collaborationId,
      sessionId: old ? 'reviewer' : 'reader',
      membershipRevision: view.membershipRevision,
      policySequence: view.policySequence,
      ready: !old,
      reason: old ? 'Old recipient is unavailable.' : null,
    });
  });
  const api = new CollaborationApiClient(fetch);
  const proof = () => 'login';
  const refresh = vi.fn(async () => view);
  const hook = renderHook(
    ({ recipient }) =>
      useConversationSending({
        api,
        view,
        draftId: draft.id,
        authScope: 'login',
        getVerifiedAuthScope: proof,
        responders: { kind: 'selected', sessionIds: [recipient] },
        refresh,
      }),
    { initialProps: { recipient: 'reviewer' } },
  );
  try {
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    hook.rerender({ recipient: 'reader' });
    await waitFor(() => expect(hook.result.current.disabledReason).toBeUndefined());
  } finally {
    await act(async () => release());
  }
  expect(hook.result.current.disabledReason).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('checks readiness again after recovery finds the original finalized reply', async () => {
  const view = sharedConversationView();
  const draft = createChatDraft();
  saveChatDraft({
    ...draft,
    text: 'Next prompt',
    collaborationSend: {
      collaborationId: view.collaborationId,
      authScope: 'login',
      input: {
        requestId: uuid(90),
        expectedMembershipRevision: view.membershipRevision,
        expectedPolicySequence: view.policySequence,
        text: sharedPrompt.text,
        responders: { kind: 'selected', sessionIds: ['architect'] },
        snapshot: null,
      },
    },
  });
  expect(getChatDraft(draft.id)?.collaborationSend).toBeDefined();
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/messages/observe')) return Response.json({ message: sharedPrompt });
    if (url.includes('/recipients/'))
      return Response.json({
        collaborationId: view.collaborationId,
        sessionId: 'architect',
        membershipRevision: view.membershipRevision,
        policySequence: view.policySequence,
        ready: true,
        reason: null,
      });
    throw Error('Recovery must not dispatch another prompt');
  });
  const api = new CollaborationApiClient(fetch);
  const proof = () => 'login';
  const refresh = vi.fn(async () => view);
  const hook = renderHook(() =>
    useConversationSending({
      api,
      view,
      draftId: draft.id,
      authScope: 'login',
      getVerifiedAuthScope: proof,
      responders: { kind: 'selected', sessionIds: ['architect'] },
      refresh,
    }),
  );
  await waitFor(() => expect(getChatDraft(draft.id)?.collaborationSend).toBeUndefined());
  await waitFor(() => expect(hook.result.current.disabledReason).toBeUndefined());
  expect(fetch).toHaveBeenCalledTimes(2);
});

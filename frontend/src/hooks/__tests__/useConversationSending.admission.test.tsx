// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationApiClient } from '@mitzo/client';
import { createChatDraft, getChatDraft, saveChatDraft } from '../../lib/chat-drafts';
import { sharedConversationView } from '../../../../tests/fixtures/symposium-shared-conversation-data';
import { useConversationSending } from '../useConversationSending';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

function fixture() {
  const view = sharedConversationView();
  const draft = createChatDraft();
  saveChatDraft({ ...draft, text: 'One deliberate press' });
  const api = new CollaborationApiClient(vi.fn());
  let release!: (ready: boolean) => void;
  const gate = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  vi.spyOn(api, 'recipientReadiness').mockImplementation(async (collaborationId, sessionId) => ({
    collaborationId,
    sessionId,
    membershipRevision: view.membershipRevision,
    policySequence: view.policySequence,
    ready: await gate,
    reason: 'Recipient needs attention',
  }));
  vi.spyOn(api, 'observeSend').mockResolvedValue({ message: null, terminal: false });
  const send = vi.spyOn(api, 'send').mockImplementation(async (_group, input) => ({
    ...view.messages[0],
    text: input.text,
    responders: ['architect'],
    deliveries: [{ ...view.messages[0].deliveries[0], status: 'queued' }],
  }));
  const options = {
    api,
    view,
    draftId: draft.id,
    authScope: 'login',
    getVerifiedAuthScope: () => 'login',
    responders: { kind: 'selected' as const, sessionIds: ['architect'] },
    refresh: async () => view,
  };
  return { options, draft, send, release };
}

it('retains a single press through readiness and excludes repeated taps without another delivery', async () => {
  const f = fixture();
  const h = renderHook(() => useConversationSending(f.options));
  let result!: Promise<boolean>;
  act(() => {
    result = h.result.current.send('One deliberate press');
  });
  await act(async () => {
    expect(await h.result.current.send('Repeated tap')).toBe(false);
  });
  expect(f.send).not.toHaveBeenCalled();
  await act(async () => {
    f.release(true);
    expect(await result).toBe(true);
  });
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.send.mock.calls[0][1].text).toBe('One deliberate press');
  expect(getChatDraft(f.draft.id)?.collaborationSend?.acknowledged).toBe(true);
});

it('explains a blocked first press and keeps its editable draft without dispatching', async () => {
  const f = fixture();
  const h = renderHook(() => useConversationSending(f.options));
  let result!: Promise<boolean>;
  act(() => {
    result = h.result.current.send('One deliberate press');
  });
  await act(async () => {
    f.release(false);
    expect(await result).toBe(false);
  });
  await waitFor(() => expect(h.result.current.error).toContain('Recipient needs attention'));
  expect(f.send).not.toHaveBeenCalled();
  expect(getChatDraft(f.draft.id)?.text).toBe('One deliberate press');
});

it('never retargets a pending first press when recipient selection changes', async () => {
  const f = fixture();
  const h = renderHook((options) => useConversationSending(options), { initialProps: f.options });
  let result!: Promise<boolean>;
  act(() => {
    result = h.result.current.send('One deliberate press');
  });
  h.rerender({ ...f.options, responders: { kind: 'selected', sessionIds: ['reviewer'] } });
  await act(async () => {
    f.release(true);
    expect(await result).toBe(false);
  });
  expect(f.send).not.toHaveBeenCalled();
  expect(getChatDraft(f.draft.id)?.text).toBe('One deliberate press');
});

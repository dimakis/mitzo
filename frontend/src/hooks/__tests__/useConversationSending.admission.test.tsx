// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationApiClient } from '@mitzo/client';
import { createChatDraft, getChatDraft, saveChatDraft } from '../../lib/chat-drafts';
import { chatStorage } from '../../lib/large-chat-storage';
import { conversationSendRequests } from '../../lib/conversation-journal';
import {
  sharedConversationView,
  uuid,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';
import { useConversationSending } from '../useConversationSending';
import { durableChatStorage } from './durable-chat-storage';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

it.each(['retention', 'cleanup'] as const)(
  'dispatches exactly once when recovery cleanup overlaps delayed %s storage',
  async (first) => {
    const storage = await durableChatStorage();
    const warning = vi.spyOn(console, 'warn');
    const f = fixture();
    const original = {
      collaborationId: f.options.view.collaborationId,
      authScope: 'login',
      acknowledged: true,
      recipientSessionIds: ['architect'],
      input: {
        requestId: uuid(97),
        text: 'Older acknowledged prompt',
        expectedMembershipRevision: f.options.view.membershipRevision,
        expectedPolicySequence: f.options.view.policySequence,
        responders: f.options.responders,
        snapshot: null,
      },
    };
    saveChatDraft({ ...getChatDraft(f.draft.id)!, collaborationSend: original });
    await chatStorage.flush();
    let finishObservation!: () => void;
    const observation = new Promise<void>((resolve) => {
      finishObservation = resolve;
    });
    vi.mocked(f.options.api.observeSend).mockImplementation(async () => {
      await observation;
      return {
        terminal: true,
        message: { ...f.options.view.messages[0], text: original.input.text, snapshot: null },
      };
    });
    let releaseStorage!: () => void;
    const disk = new Promise<void>((resolve) => {
      releaseStorage = resolve;
    });
    let blocked = false;
    storage.gate(async () => {
      if (!blocked) {
        blocked = true;
        await disk;
      }
    });
    const h = renderHook(() => useConversationSending(f.options));
    f.release(true);
    let sent!: Promise<boolean>;
    try {
      if (first === 'cleanup') {
        finishObservation();
        await waitFor(() => expect(blocked).toBe(true));
      }
      act(() => {
        sent = h.result.current.send('One deliberate press');
      });
      if (first === 'retention') {
        await waitFor(() => expect(blocked).toBe(true));
        finishObservation();
      }
      await act(async () => {});
      expect(f.send).not.toHaveBeenCalled();
      await act(async () => {
        releaseStorage();
        expect(await sent).toBe(true);
      });
      expect(f.send).toHaveBeenCalledOnce();
      const requestId = f.send.mock.calls[0][1].requestId;
      expect(conversationSendRequests(getChatDraft(f.draft.id))).toMatchObject([
        { acknowledged: true, input: { requestId, text: 'One deliberate press' } },
      ]);
      expect(h.result.current.error).toBeUndefined();
      expect(warning).not.toHaveBeenCalled();
      h.unmount();
      await storage.reopen();
      expect(getChatDraft(f.draft.id)?.collaborationSend?.input.requestId).toBe(requestId);
      expect(getChatDraft(f.draft.id)?.text).toBe('One deliberate press');
    } finally {
      finishObservation();
      releaseStorage();
    }
  },
);

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

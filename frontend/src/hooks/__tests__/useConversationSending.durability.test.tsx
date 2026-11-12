// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationApiClient } from '@mitzo/client';
import { createChatDraft, getChatDraft, saveChatDraft } from '../../lib/chat-drafts';
import { chatStorage } from '../../lib/large-chat-storage';
import {
  sharedConversationView,
  uuid,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';
import { useConversationSending } from '../useConversationSending';
import { durableChatStorage } from './durable-chat-storage';
import { AUTH_LOST_EVENT } from '../../lib/api-fetch';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

for (const phase of ['send', 'stop'] as const)
  it.each([
    'commit',
    'reject',
    'auth loss',
    'auth restored',
    'unmount',
    'policy change',
    ...(phase === 'send' ? (['Stop while saving', 'context change'] as const) : []),
  ] as const)(
    `retains durable ${phase} identity before its POST, including %s`,
    async (outcome) => {
      const storage = await durableChatStorage();
      const view = sharedConversationView();
      const draft = createChatDraft();
      const original = {
        collaborationId: view.collaborationId,
        authScope: 'login',
        input: {
          requestId: uuid(96),
          expectedMembershipRevision: view.membershipRevision,
          expectedPolicySequence: view.policySequence,
          text: 'Original prompt',
          responders: { kind: 'selected' as const, sessionIds: ['architect'] },
          snapshot: null,
        },
      };
      saveChatDraft({
        ...draft,
        text: 'Next draft remains',
        collaborationSend: phase === 'stop' ? original : undefined,
      });
      await chatStorage.flush();
      const api = new CollaborationApiClient(vi.fn());
      vi.spyOn(api, 'recipientReadiness').mockResolvedValue({
        collaborationId: view.collaborationId,
        sessionId: 'architect',
        membershipRevision: view.membershipRevision,
        policySequence: view.policySequence,
        ready: true,
        reason: null,
      });
      const observe = vi
        .spyOn(api, 'observeSend')
        .mockResolvedValue({ message: null, terminal: false });
      const send = vi.spyOn(api, 'send').mockRejectedValue(Error('Accepted response lost'));
      const stop = vi
        .spyOn(api, 'stopSend')
        .mockResolvedValue({ requestId: original.input.requestId, recipients: [] });
      let scope: string | undefined = 'login';
      const options = {
        api,
        view,
        draftId: draft.id,
        authScope: 'login',
        getVerifiedAuthScope: () => scope,
        contextDisabledReason: undefined as string | undefined,
        responders: original.input.responders,
        refresh: async () => view,
      };
      const mount = () =>
        renderHook((props = options) => useConversationSending(props), { initialProps: options });
      const h = mount();
      if (phase === 'send')
        await waitFor(() => expect(h.result.current.disabledReason).toBeUndefined());
      else await act(async () => {});
      let release!: () => void;
      let reject!: (error: Error) => void;
      const gate = new Promise<void>((resolve, fail) => {
        release = resolve;
        reject = fail;
      });
      let pending = false;
      storage.gate(async (record) => {
        const journal = JSON.parse(record.value ?? 'null')?.collaborationSend;
        if (!pending && journal && (phase === 'send' || journal.stopRequested)) {
          pending = true;
          await gate;
        }
      });
      let operation!: Promise<unknown>;
      act(() => {
        operation =
          phase === 'send' ? h.result.current.send('Original prompt') : h.result.current.stop();
      });
      await waitFor(() => expect(pending).toBe(true));
      const post = phase === 'send' ? send : stop;
      try {
        expect(post).not.toHaveBeenCalled();
        if (outcome === 'auth loss' || outcome === 'auth restored') {
          scope = undefined;
          act(() => window.dispatchEvent(new Event(AUTH_LOST_EVENT)));
          if (outcome === 'auth restored') scope = 'login';
        }
        if (outcome === 'unmount') h.unmount();
        if (outcome === 'policy change')
          h.rerender({ ...options, view: { ...view, policySequence: view.policySequence + 1 } });
        if (outcome === 'context change')
          h.rerender({ ...options, contextDisabledReason: 'Review changed' });
        if (outcome === 'Stop while saving')
          await act(async () => {
            await h.result.current.stop();
          });
        await act(async () => {
          if (outcome === 'reject') reject(Error('IndexedDB transaction aborted'));
          else release();
          await operation;
        });
        if (outcome === 'commit') {
          expect(post).toHaveBeenCalledTimes(1);
          const saved = getChatDraft(draft.id)!.collaborationSend!;
          h.unmount();
          await storage.reopen();
          expect(getChatDraft(draft.id)!.collaborationSend).toEqual(saved);
          const restored = mount();
          await act(async () => {
            await restored.result.current.check();
          });
          expect(observe.mock.calls.at(-1)![1]).toEqual(saved.input);
          expect(post).toHaveBeenCalledTimes(1);
        } else {
          expect(post).not.toHaveBeenCalled();
          if (outcome === 'reject') expect(h.result.current.error).toContain('Could not retain');
          if (outcome !== 'unmount') h.unmount();
          await storage.reopen();
          expect(getChatDraft(draft.id)?.text).toBe('Next draft remains');
          if (outcome === 'reject')
            expect(getChatDraft(draft.id)?.collaborationSend?.stopRequested).not.toBe(true);
          else if (phase === 'send') {
            expect(getChatDraft(draft.id)?.collaborationSend).toBeUndefined();
            scope = 'login';
            const restored = mount();
            await waitFor(() => expect(restored.result.current.disabledReason).toBeUndefined());
            expect(post).not.toHaveBeenCalled();
          }
        }
      } finally {
        release();
      }
    },
  );

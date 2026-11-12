// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MitzoApiClient } from '@mitzo/client';
import {
  CollaborationPromptReviewResultSchema,
  type CollaborationForwardRead,
} from '@mitzo/protocol';
import {
  sharedConversationView,
  uuid,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../../lib/api-fetch';
import * as drafts from '../../lib/chat-drafts';
import { useConversationForwarding } from '../useConversationForwarding';
import { useDraft } from '../useDraft';
import { chatStorage } from '../../lib/large-chat-storage';
import { durableChatStorage as durableStorage } from './durable-chat-storage';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

function fixture() {
  const api = new MitzoApiClient(vi.fn());
  const view = sharedConversationView();
  const review = CollaborationPromptReviewResultSchema.parse({
    snapshot: {
      version: 1,
      snapshotId: uuid(90),
      sha256: 'a'.repeat(64),
      sourceConversationId: 'architect',
      boundary: { sequence: 1, messageId: 'source' },
      mode: 'selected',
      purpose: 'Review selected context',
      joiningBrief: 'A deliberate note',
      messages: [
        {
          conversationId: 'architect',
          sequence: 1,
          messageId: 'source',
          author: 'operator',
          source: null,
          blocks: [
            {
              blockId: 'text',
              content: 'Private source bytes stay out of browser storage',
              sha256: 'b'.repeat(64),
            },
          ],
        },
      ],
      artifacts: [
        {
          artifactId: 'artifact',
          sourceConversationId: 'architect',
          revision: 2,
          sha256: 'c'.repeat(64),
          mediaType: 'text/plain',
          sizeBytes: 3,
          contentBase64: 'b2xk',
        },
      ],
      summary: null,
      capacity: { status: 'unverified', reason: 'Offline test' },
    },
    recipientSessionIds: ['reviewer'],
    settings: {},
    expectedMembershipRevision: view.membershipRevision,
    expectedPolicySequence: view.policySequence,
    requiresReview: false,
    artifactLabels: [],
  });
  const draft = drafts.createChatDraft();
  drafts.saveChatDraft({ ...draft, text: 'Unsent prompt remains intact' });
  let retained: CollaborationForwardRead;
  const prepare = vi
    .spyOn(api.collaborations, 'prepareForward')
    .mockImplementation(async (_g, _c, input) => {
      retained = {
        version: 1,
        forwardId: uuid(91),
        requestId: input.selection.requestId,
        selection: input.selection,
        note: input.note,
        selectionFingerprint: 'd'.repeat(64),
        packetSha256: 'e'.repeat(64),
        state: 'prepared',
        confirmation: null,
        deliveries: [],
      };
      return retained;
    });
  const observe = vi
    .spyOn(api.collaborations, 'observeForwardPreparation')
    .mockImplementation(async () => retained);
  const read = vi.spyOn(api.collaborations, 'forward').mockImplementation(async () => retained);
  const confirm = vi
    .spyOn(api.collaborations, 'confirmForward')
    .mockImplementation(async (_g, _c, input) => {
      const receipt = {
        version: 1 as const,
        requestId: input.requestId,
        forward: input.forward,
        messageId: uuid(92),
        deliveries: [],
      };
      retained = { ...retained, state: 'confirmed', confirmation: receipt };
      return receipt;
    });
  const send = vi.spyOn(api.collaborations, 'send');
  const options = {
    api,
    view,
    review,
    reviewCurrent: true,
    clientId: 'connection',
    authScope: 'login',
    getVerifiedAuthScope: () => 'login',
    draftId: draft.id,
    refresh: vi.fn(),
  };
  const mount = () =>
    renderHook((props = options) => useConversationForwarding(props), { initialProps: options });
  const ready = async (h: ReturnType<typeof mount>) => {
    act(() => h.result.current.prepare());
    await waitFor(() => expect(h.result.current.canConfirm).toBe(true));
  };
  return { api, options, mount, ready, draft, prepare, observe, read, confirm, send };
}

for (const phase of ['prepare', 'confirm'] as const)
  it.each(['commit', 'reject', 'auth loss', 'unmount', 'policy change'] as const)(
    `waits for durable ${phase} recovery before POST, including %s`,
    async (outcome) => {
      const storage = await durableStorage();
      const f = fixture();
      await chatStorage.flush();
      const h = f.mount();
      if (phase === 'confirm') await f.ready(h);
      let release!: () => void;
      let reject!: (error: Error) => void;
      const gate = new Promise<void>((resolve, fail) => {
        release = resolve;
        reject = fail;
      });
      let pending = false;
      storage.gate(async (record) => {
        const saved = JSON.parse(record.value ?? 'null')?.collaborationForward;
        if (!pending && saved && (phase === 'prepare' || saved.confirmationAttempted)) {
          pending = true;
          await gate;
        }
      });
      const post = phase === 'prepare' ? f.prepare : f.confirm;
      act(() => h.result.current[phase]());
      await waitFor(() => expect(pending).toBe(true));
      try {
        expect(post).not.toHaveBeenCalled();
        if (outcome === 'auth loss') act(() => window.dispatchEvent(new Event(AUTH_LOST_EVENT)));
        if (outcome === 'unmount') h.unmount();
        if (outcome === 'policy change')
          h.rerender({
            ...f.options,
            view: { ...f.options.view, policySequence: f.options.view.policySequence + 1 },
          });
        await act(async () => {
          if (outcome === 'reject') reject(Error('IndexedDB transaction aborted'));
          else release();
        });
        if (outcome === 'commit') {
          await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
          await waitFor(() => expect(h.result.current.busy).toBe(false));
          const original = drafts.getChatDraft(f.draft.id)!.collaborationForward!;
          expect(original.confirmation).toBeDefined();
          expect(h.result.current.error).toBeUndefined();
          h.unmount();
          await storage.reopen();
          expect(drafts.getChatDraft(f.draft.id)!.collaborationForward).toEqual(original);
          const restored = f.mount();
          act(() => restored.result.current.check());
          await waitFor(() => expect(f.observe).toHaveBeenCalled());
          await waitFor(() =>
            expect(restored.result.current.observation?.state).toBe(
              phase === 'prepare' ? 'prepared' : 'confirmed',
            ),
          );
          expect(f.observe.mock.calls.at(-1)![1]).toBe(original.input.selection.requestId);
          expect(post).toHaveBeenCalledTimes(1);
        } else {
          if (outcome === 'reject')
            await waitFor(() => expect(h.result.current.error).toContain('Could not retain'));
          else if (outcome === 'policy change') {
            await waitFor(() => expect(h.result.current.error).toContain('changed'));
            expect(h.result.current.canClear).toBe(true);
            expect(
              drafts.getChatDraft(f.draft.id)?.collaborationForward?.confirmationAttempted,
            ).toBe(false);
          } else
            await act(async () => {
              await chatStorage.flush();
            });
          expect(post).not.toHaveBeenCalled();
          if (outcome !== 'unmount') h.unmount();
          await storage.reopen();
          const saved = drafts.getChatDraft(f.draft.id)!;
          expect(saved.text).toBe('Unsent prompt remains intact');
          if (outcome === 'reject')
            expect(saved.collaborationForward?.confirmationAttempted).not.toBe(true);
          if (phase === 'confirm' && (outcome === 'auth loss' || outcome === 'unmount')) {
            expect(saved.collaborationForward?.confirmationAttempted).toBe(false);
            const restored = f.mount();
            restored.rerender({
              ...f.options,
              view: {
                ...f.options.view,
                membershipRevision: f.options.view.membershipRevision + 1,
              },
            });
            act(() => restored.result.current.check());
            await waitFor(() =>
              expect(restored.result.current.observation?.state).toBe('prepared'),
            );
            expect(restored.result.current.canConfirm).toBe(false);
            expect(restored.result.current.canClear).toBe(true);
            act(() => restored.result.current.clear());
            await waitFor(() => expect(restored.result.current.retained).toBe(false));
            expect(drafts.getChatDraft(f.draft.id)?.text).toBe('Unsent prompt remains intact');
            expect(f.confirm).not.toHaveBeenCalled();
          }
        }
      } finally {
        release();
      }
    },
  );

it.each(['earlier uncertainty', 'replacement journal'] as const)(
  'cancelled confirmation preserves %s',
  async (retainedCase) => {
    const storage = await durableStorage();
    const f = fixture();
    const h = f.mount();
    await f.ready(h);
    if (retainedCase === 'earlier uncertainty') {
      f.confirm.mockRejectedValueOnce(Error('Confirmation response lost'));
      act(() => h.result.current.confirm());
      await waitFor(() => expect(h.result.current.error).toContain('response lost'));
      act(() => h.result.current.check());
      await waitFor(() => expect(h.result.current.canConfirm).toBe(true));
    }
    const original = drafts.getChatDraft(f.draft.id)!.collaborationForward!;
    const callsBefore = f.confirm.mock.calls.length;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending = false;
    storage.gate(async (record) => {
      const saved = JSON.parse(record.value ?? 'null')?.collaborationForward;
      if (!pending && saved?.confirmationAttempted) {
        pending = true;
        await gate;
      }
    });
    // A prior ambiguous journal already has this value; rotate the local text
    // so the queued disk still exercises a real asynchronous write.
    drafts.saveChatDraft({ ...drafts.getChatDraft(f.draft.id)!, text: 'Newer prompt edit' });
    act(() => h.result.current.confirm());
    await waitFor(() => expect(pending).toBe(true));
    h.unmount();
    const replacement =
      retainedCase === 'replacement journal'
        ? {
            ...original,
            input: {
              ...original.input,
              selection: { ...original.input.selection, requestId: uuid(99) },
            },
          }
        : undefined;
    if (replacement)
      drafts.saveChatDraft({
        ...drafts.getChatDraft(f.draft.id)!,
        collaborationForward: replacement,
      });
    await act(async () => {
      release();
      await chatStorage.flush();
    });
    await storage.reopen();
    expect(f.confirm).toHaveBeenCalledTimes(callsBefore);
    expect(drafts.getChatDraft(f.draft.id)?.collaborationForward).toEqual(replacement ?? original);
    expect(drafts.getChatDraft(f.draft.id)?.text).toBe('Newer prompt edit');
  },
);

it('forwards only inspected selectors and versions, preserving the draft without requesting a reply', async () => {
  const f = fixture();
  const h = f.mount();
  await f.ready(h);
  expect(f.prepare.mock.calls[0][2]).toMatchObject({
    selection: {
      target: { sessionIds: ['reviewer'] },
      messages: [{ messageId: 'source', blocks: [{ blockId: 'text', sha256: 'b'.repeat(64) }] }],
      artifacts: [{ kind: 'transcript_reference', revision: 2 }],
    },
  });
  const journal = drafts.getChatDraft(f.draft.id)!.collaborationForward!;
  expect(JSON.stringify(journal)).not.toContain('Private source bytes');
  expect(JSON.stringify(journal)).not.toContain('contentBase64');
  act(() => h.result.current.confirm());
  await waitFor(() => expect(h.result.current.observation?.state).toBe('confirmed'));
  expect(f.confirm.mock.calls[0][2]).toEqual(journal.confirmation);
  expect(f.confirm.mock.calls[0][2].requestReply).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
  expect(drafts.getChatDraft(f.draft.id)?.text).toBe('Unsent prompt remains intact');
});

it('recovers a lost confirmation after remount by reading the original request without another POST', async () => {
  const f = fixture();
  let h = f.mount();
  await f.ready(h);
  const success = f.confirm.getMockImplementation()!;
  f.confirm.mockImplementationOnce(async (...args) => {
    await success(...args);
    throw Error('Response lost');
  });
  act(() => h.result.current.confirm());
  await waitFor(() => expect(h.result.current.error).toBe('Response lost'));
  expect(h.result.current.canClear).toBe(false);
  expect(drafts.deleteChatDraft(f.draft.id)).toBe(false);
  const composer = renderHook(() =>
    useDraft(undefined, undefined, drafts.chatDraftStorageKey(f.draft.id)),
  );
  const proof = composer.result.current[4].capture()!;
  act(() => expect(composer.result.current[4].consume(proof)).toBe(true));
  expect(drafts.getChatDraft(f.draft.id)?.collaborationForward?.confirmationAttempted).toBe(true);
  composer.unmount();
  h.unmount();
  h = f.mount();
  expect(h.result.current.retained).toBe(true);
  act(() => h.result.current.check());
  await waitFor(() => expect(h.result.current.observation?.state).toBe('confirmed'));
  expect(f.prepare).toHaveBeenCalledTimes(1);
  expect(f.confirm).toHaveBeenCalledTimes(1);
  expect(f.observe.mock.calls[0][1]).toBe(f.prepare.mock.calls[0][2].selection.requestId);
});

it('requires inspection again after remount before confirming a recovered preparation', async () => {
  const f = fixture();
  const h = f.mount();
  await f.ready(h);
  h.unmount();
  const recovered = renderHook(() =>
    useConversationForwarding({ ...f.options, review: undefined, reviewCurrent: false }),
  );
  act(() => recovered.result.current.check());
  await waitFor(() => expect(recovered.result.current.observation?.state).toBe('prepared'));
  expect(recovered.result.current.canConfirm).toBe(false);
  expect(f.confirm).not.toHaveBeenCalled();
  const inspect = vi
    .spyOn(f.api.collaborations, 'reviewPrompt')
    .mockResolvedValue(f.options.review);
  const original = drafts.getChatDraft(f.draft.id)!.collaborationForward!;
  act(() => recovered.result.current.inspect());
  await waitFor(() => expect(recovered.result.current.canConfirm).toBe(true));
  expect(inspect.mock.calls[0][2]).toEqual(original.reviewInput);
  act(() => recovered.result.current.confirm());
  await waitFor(() => expect(recovered.result.current.observation?.state).toBe('confirmed'));
  expect(f.confirm.mock.calls[0][2]).toEqual(original.confirmation);
  expect(f.prepare).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
});

it('retains the original confirmation identity after pre-commit response loss and newer context edits', async () => {
  const f = fixture();
  const h = f.mount();
  await f.ready(h);
  f.confirm.mockRejectedValueOnce(Error('Connection lost before acceptance'));
  act(() => h.result.current.confirm());
  await waitFor(() => expect(h.result.current.error).toContain('Connection lost'));
  const saved = drafts.getChatDraft(f.draft.id)!;
  const newerContext = {
    collaborationId: f.options.view.collaborationId,
    authScope: 'login',
    form: { mode: 'selected' as const, purpose: 'A newer purpose', brief: '', messageIds: [] },
    attached: false,
  };
  drafts.saveChatDraft({ ...saved, collaborationContext: newerContext });
  h.unmount();
  const recovered = renderHook(() =>
    useConversationForwarding({ ...f.options, review: undefined, reviewCurrent: false }),
  );
  vi.spyOn(f.api.collaborations, 'reviewPrompt').mockResolvedValue(f.options.review);
  act(() => recovered.result.current.check());
  await waitFor(() => expect(recovered.result.current.observation?.state).toBe('prepared'));
  expect(recovered.result.current.canClear).toBe(false);
  act(() => recovered.result.current.inspect());
  await waitFor(() => expect(recovered.result.current.canConfirm).toBe(true));
  act(() => recovered.result.current.confirm());
  await waitFor(() => expect(recovered.result.current.observation?.state).toBe('confirmed'));
  expect(f.confirm.mock.calls[1][2]).toEqual(f.confirm.mock.calls[0][2]);
  expect(drafts.getChatDraft(f.draft.id)?.collaborationContext).toEqual(newerContext);
  expect(drafts.getChatDraft(f.draft.id)?.text).toBe(saved.text);
  expect(f.prepare).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
});

it('rejects original reinspection with changed selectors or stale policy', async () => {
  const f = fixture();
  const h = f.mount();
  await f.ready(h);
  h.rerender({ ...f.options, reviewCurrent: false });
  const inspect = vi.spyOn(f.api.collaborations, 'reviewPrompt').mockResolvedValue({
    ...f.options.review,
    recipientSessionIds: ['architect'],
  });
  act(() => h.result.current.inspect());
  await waitFor(() => expect(h.result.current.error).toContain('does not match'));
  expect(h.result.current.canConfirm).toBe(false);
  inspect.mockResolvedValue({ ...f.options.review, requiresReview: true });
  act(() => h.result.current.inspect());
  await waitFor(() => expect(h.result.current.busy).toBe(false));
  expect(h.result.current.canConfirm).toBe(false);
  inspect.mockResolvedValue(f.options.review);
  act(() => h.result.current.inspect());
  await waitFor(() => expect(h.result.current.canConfirm).toBe(true));
  h.rerender({
    ...f.options,
    reviewCurrent: false,
    view: { ...f.options.view, policySequence: f.options.view.policySequence + 1 },
  });
  expect(h.result.current.canConfirm).toBe(false);
  expect(f.confirm).not.toHaveBeenCalled();
});

it('rejects changed recipients, exact source bytes and membership before confirmation', async () => {
  const f = fixture();
  const h = f.mount();
  await f.ready(h);
  h.rerender({ ...f.options, review: { ...f.options.review, recipientSessionIds: ['architect'] } });
  expect(h.result.current.canConfirm).toBe(false);
  h.rerender({
    ...f.options,
    view: { ...f.options.view, membershipRevision: f.options.view.membershipRevision + 1 },
  });
  expect(h.result.current.canConfirm).toBe(false);
  h.rerender({
    ...f.options,
    review: {
      ...f.options.review,
      snapshot: { ...f.options.review.snapshot, joiningBrief: 'Changed note' },
    },
  });
  expect(h.result.current.canConfirm).toBe(false);
  expect(f.confirm).not.toHaveBeenCalled();
});

it('does not POST when recovery cannot be saved and preserves an existing draft', async () => {
  const f = fixture();
  const h = f.mount();
  vi.spyOn(drafts, 'saveChatDraft').mockReturnValue(false);
  act(() => h.result.current.prepare());
  await waitFor(() => expect(h.result.current.error).toContain('Could not retain'));
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.confirm).not.toHaveBeenCalled();
});

it('clears visible receipts on auth loss and refuses stale restoration or a different login', async () => {
  const f = fixture();
  const h = f.mount();
  await f.ready(h);
  await act(async () => {
    window.dispatchEvent(new Event(AUTH_LOST_EVENT));
    window.dispatchEvent(new Event(AUTH_RESTORED_EVENT));
    window.dispatchEvent(new Event(AUTH_LOST_EVENT));
  });
  expect(h.result.current.observation).toBeUndefined();
  expect(h.result.current.canConfirm).toBe(false);
  h.rerender({ ...f.options, authScope: 'other', getVerifiedAuthScope: () => 'other' });
  expect(h.result.current.canPrepare).toBe(false);
  expect(h.result.current.canConfirm).toBe(false);
  expect(f.confirm).not.toHaveBeenCalled();
});

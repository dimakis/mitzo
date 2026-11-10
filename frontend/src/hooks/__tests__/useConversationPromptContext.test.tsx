// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MitzoApiClient } from '@mitzo/client';
import {
  CollaborationDurableTranscriptSchema,
  CollaborationPromptReviewResultSchema,
  type CollaborationPromptReviewInput,
} from '@mitzo/protocol';
import {
  sharedConversationView,
  uuid,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../../lib/api-fetch';
import * as drafts from '../../lib/chat-drafts';
import { useConversationPromptContext } from '../useConversationPromptContext';
import { ConversationPromptContext } from '../../components/ConversationPromptContext';
import { installDialogStub } from '../../components/__tests__/dialog-stub';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});
function fixture() {
  const api = new MitzoApiClient(vi.fn());
  const view = sharedConversationView();
  const source = CollaborationDurableTranscriptSchema.parse({
    sourceConversationId: 'architect',
    boundary: { sequence: 1, messageId: 'source' },
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
            content: 'Private source material stays out of browser persistence',
            sha256: 'b'.repeat(64),
          },
        ],
      },
    ],
  });
  const result = (input: CollaborationPromptReviewInput) =>
    CollaborationPromptReviewResultSchema.parse({
      snapshot: {
        sourceConversationId: input.selection.sourceConversationId,
        boundary: input.selection.boundary,
        mode: input.selection.mode,
        purpose: input.selection.purpose,
        joiningBrief: input.selection.joiningBrief,
        version: 1,
        snapshotId: uuid(94),
        sha256: 'a'.repeat(64),
        messages: source.messages,
        artifacts: [],
        summary: null,
        capacity: { status: 'unverified', reason: 'Offline capacity unverified' },
      },
      recipientSessionIds: input.recipientSessionIds,
      settings: {},
      expectedMembershipRevision: input.selection.expectedMembershipRevision,
      expectedPolicySequence: input.expectedPolicySequence,
      requiresReview: false,
      artifactLabels: [],
    });
  vi.spyOn(api, 'getDurableSessionTranscript').mockResolvedValue(source);
  vi.spyOn(api.collaborations, 'sourceArtifacts').mockResolvedValue({
    sourceConversationId: 'architect',
    artifacts: [],
  });
  vi.spyOn(api.collaborations, 'reviewPrompt').mockImplementation(async (_group, _client, input) =>
    result(input),
  );
  const draft = drafts.createChatDraft();
  drafts.saveChatDraft({ ...draft, text: 'Original editable prompt' });
  const proof = () => 'login';
  const options = {
    api,
    sourceConversationId: 'architect',
    clientId: 'connection',
    view,
    responders: { kind: 'selected' as const, sessionIds: ['reviewer'] },
    draftId: draft.id,
    authScope: 'login',
    getVerifiedAuthScope: proof,
  };
  const mount = () =>
    renderHook((props = options) => useConversationPromptContext(props), { initialProps: options });
  const edit = (hook: ReturnType<typeof mount>) =>
    act(() =>
      hook.result.current.edit({
        mode: 'selected',
        purpose: 'Review exact selected source',
        brief: 'Exact reviewed brief',
        messageIds: ['source'],
      }),
    );
  return { api, view, source, result, draft, options, mount, edit };
}

it.each(['missing', 'unavailable'])(
  'can remove a retained %s artifact after reload without discarding source or brief edits',
  async (state) => {
    installDialogStub();
    const f = fixture();
    const pin = { artifactId: 'saved-design', revision: 1, sha256: 'c'.repeat(64) };
    const selected = {
      mode: 'selected' as const,
      purpose: 'Keep my purpose',
      brief: 'Keep my brief',
      messageIds: ['source'],
      artifacts: [pin],
    };
    drafts.saveChatDraft({
      ...drafts.getChatDraft(f.draft.id)!,
      collaborationContext: {
        collaborationId: f.view.collaborationId,
        authScope: 'login',
        form: selected,
        attached: false,
      },
    });
    vi.mocked(f.api.collaborations.sourceArtifacts).mockResolvedValue({
      sourceConversationId: 'architect',
      artifacts: state === 'missing' ? [] : [{ ...pin, title: 'Saved design', available: false }],
    });
    function Controls() {
      const flow = useConversationPromptContext(f.options);
      return <ConversationPromptContext flow={flow} names={{}} disabled={false} />;
    }
    render(<Controls />);
    fireEvent.click(screen.getByRole('button', { name: 'Review prompt context' }));
    const dialog = await screen.findByRole('dialog', { name: 'Context for this prompt' });
    const stale = await within(dialog).findByRole('checkbox', {
      name: state === 'missing' ? /Previously selected artifact/ : /Saved design/,
    });
    await waitFor(() => expect((stale as HTMLInputElement).disabled).toBe(false));
    expect((stale as HTMLInputElement).checked).toBe(true);
    fireEvent.click(stale);
    expect(
      (within(dialog).getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).value,
    ).toBe('Keep my purpose');
    expect(
      (within(dialog).getByRole('textbox', { name: 'Brief', exact: true }) as HTMLInputElement)
        .value,
    ).toBe('Keep my brief');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review context', exact: true }));
    await waitFor(() =>
      expect(
        (
          within(dialog).getByRole('button', {
            name: 'Attach reviewed context',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    const input = vi.mocked(f.api.collaborations.reviewPrompt).mock.calls[0][2];
    expect(input.selection).toMatchObject({
      mode: selected.mode,
      purpose: selected.purpose,
      messageIds: selected.messageIds,
      artifacts: [],
      joiningBrief: selected.brief,
    });
  },
);

it('recovers a lost review response by exact retained selectors after remount without inference or private persistence', async () => {
  const f = fixture();
  vi.mocked(f.api.collaborations.reviewPrompt).mockRejectedValueOnce(
    Error('Response lost after review was saved'),
  );
  let hook = f.mount();
  f.edit(hook);
  act(() => hook.result.current.reviewContext());
  await waitFor(() => expect(hook.result.current.error).toContain('Response lost'));
  const original = drafts.getChatDraft(f.draft.id)!.collaborationContext!;
  expect(original.input).toBeTruthy();
  expect(original.attached).toBe(false);
  expect(JSON.stringify(original)).not.toContain('Private source material');
  hook.unmount();
  hook = f.mount();
  expect(f.api.collaborations.reviewPrompt).toHaveBeenCalledOnce();
  act(() => hook.result.current.reviewContext());
  await waitFor(() => expect(hook.result.current.canAttach).toBe(true));
  expect(vi.mocked(f.api.collaborations.reviewPrompt).mock.calls[1][2]).toEqual(original.input);
  act(() => hook.result.current.attach());
  expect(hook.result.current.snapshot).toEqual({ snapshotId: uuid(94), sha256: 'a'.repeat(64) });
  expect(drafts.getChatDraft(f.draft.id)!.text).toBe('Original editable prompt');
  hook.unmount();
  hook = f.mount();
  expect(hook.result.current.disabledReason).toContain('Check or review');
  expect(hook.result.current.snapshot).toBeUndefined();
  expect(f.api.collaborations.reviewPrompt).toHaveBeenCalledTimes(2);
  act(() => hook.result.current.reviewContext());
  await waitFor(() => expect(hook.result.current.canAttach).toBe(true));
  act(() => hook.result.current.attach());
  expect(hook.result.current.disabledReason).toBeUndefined();
});

it('requires explicit refreezing when recipients or policy change during a review', async () => {
  const f = fixture();
  const hook = f.mount();
  f.edit(hook);
  let release!: () => void;
  vi.mocked(f.api.collaborations.reviewPrompt).mockImplementationOnce(
    async (_group, _client, input) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return f.result(input);
    },
  );
  act(() => hook.result.current.reviewContext());
  await waitFor(() => expect(f.api.collaborations.reviewPrompt).toHaveBeenCalledOnce());
  const next = {
    ...f.options,
    view: { ...f.view, policySequence: f.view.policySequence + 1 },
    responders: { kind: 'selected' as const, sessionIds: ['architect', 'reviewer'] },
  };
  hook.rerender(next);
  await act(async () => release());
  expect(hook.result.current.canAttach).toBe(false);
  const original = drafts.getChatDraft(f.draft.id)!.collaborationContext!.input!;
  act(() => hook.result.current.reviewContext(true));
  await waitFor(() => expect(hook.result.current.canAttach).toBe(true));
  const fresh = drafts.getChatDraft(f.draft.id)!.collaborationContext!.input!;
  expect(fresh.selection.requestId).not.toBe(original.selection.requestId);
  expect(fresh.recipientSessionIds).toEqual(['architect', 'reader', 'reviewer']);
  expect(fresh.expectedPolicySequence).toBe(next.view.policySequence);
});

it('retains exact artifact selectors and refuses a review that substitutes another saved revision', async () => {
  const f = fixture();
  const hook = f.mount();
  const pin = { artifactId: 'saved-design', revision: 2, sha256: 'c'.repeat(64) };
  act(() =>
    hook.result.current.edit({
      mode: 'selected',
      purpose: 'Review saved design',
      brief: 'Exact version only',
      messageIds: ['source'],
      artifacts: [pin],
    }),
  );
  vi.mocked(f.api.collaborations.reviewPrompt).mockImplementationOnce(
    async (_group, _client, input) => ({
      ...f.result(input),
      snapshot: {
        ...f.result(input).snapshot,
        artifacts: [
          {
            ...pin,
            revision: 3,
            sourceConversationId: 'architect',
            mediaType: 'text/plain',
            sizeBytes: 0,
            contentBase64: '',
          },
        ],
      },
    }),
  );
  act(() => hook.result.current.reviewContext());
  await waitFor(() => expect(hook.result.current.error).toContain('changed the selected'));
  expect(hook.result.current.canAttach).toBe(false);
  const retained = drafts.getChatDraft(f.draft.id)!.collaborationContext!;
  expect(retained.input!.selection.artifacts).toEqual([pin]);
  expect(retained.snapshot).toBeUndefined();
});

it('shows catalog failures and never publishes artifact metadata returned after authority is lost', async () => {
  const f = fixture();
  const hook = f.mount();
  vi.mocked(f.api.collaborations.sourceArtifacts).mockRejectedValueOnce(
    Error('Artifact inventory unavailable'),
  );
  act(() => hook.result.current.show());
  await waitFor(() => expect(hook.result.current.error).toBe('Artifact inventory unavailable'));
  let release!: () => void;
  vi.mocked(f.api.collaborations.sourceArtifacts).mockImplementationOnce(async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return {
      sourceConversationId: 'architect',
      artifacts: [
        {
          artifactId: 'private-design',
          revision: 1,
          sha256: 'c'.repeat(64),
          title: 'Private artifact title',
          available: true,
        },
      ],
    };
  });
  act(() => hook.result.current.show());
  await waitFor(() => expect(f.api.collaborations.sourceArtifacts).toHaveBeenCalledTimes(2));
  await act(async () => {
    window.dispatchEvent(new Event(AUTH_LOST_EVENT));
    release();
  });
  expect(hook.result.current.artifacts).toBeUndefined();
  expect(hook.result.current.unavailable).toBe(true);
  expect(f.api.collaborations.reviewPrompt).not.toHaveBeenCalled();
});

it('fences late private review material on auth loss and a newer loss wins queued restoration', async () => {
  const f = fixture();
  const hook = f.mount();
  f.edit(hook);
  let release!: () => void;
  vi.mocked(f.api.collaborations.reviewPrompt).mockImplementationOnce(
    async (_group, _client, input) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return f.result(input);
    },
  );
  act(() => hook.result.current.reviewContext());
  await waitFor(() => expect(f.api.collaborations.reviewPrompt).toHaveBeenCalledOnce());
  await act(async () => {
    window.dispatchEvent(new Event(AUTH_RESTORED_EVENT));
    window.dispatchEvent(new Event(AUTH_LOST_EVENT));
    release();
  });
  expect(hook.result.current.review).toBeUndefined();
  expect(hook.result.current.unavailable).toBe(true);
  expect(vi.mocked(f.api.collaborations.reviewPrompt).mock.calls[0][3]?.aborted).toBe(true);
  await act(async () => {
    window.dispatchEvent(new Event(AUTH_RESTORED_EVENT));
  });
  expect(hook.result.current.unavailable).toBe(false);
  expect(hook.result.current.review).toBeUndefined();
  expect(f.api.collaborations.reviewPrompt).toHaveBeenCalledOnce();
  act(() => hook.result.current.reviewContext());
  await waitFor(() => expect(hook.result.current.canAttach).toBe(true));
});

it('can reopen after closing a source read that ignores cancellation and refuses its late result', async () => {
  const f = fixture();
  const hook = f.mount();
  let release!: () => void;
  vi.mocked(f.api.getDurableSessionTranscript).mockImplementationOnce(async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return { ...f.source, sourceConversationId: 'foreign' };
  });
  act(() => hook.result.current.show());
  act(() => hook.result.current.close());
  act(() => hook.result.current.show());
  await waitFor(() => expect(hook.result.current.source).toEqual(f.source));
  await act(async () => release());
  expect(hook.result.current.source).toEqual(f.source);
  expect(hook.result.current.error).toBeUndefined();
  expect(f.api.getDurableSessionTranscript).toHaveBeenCalledTimes(2);
});

it('keeps a mismatched response unattachable and retains the original request for inspection', async () => {
  const f = fixture();
  const hook = f.mount();
  f.edit(hook);
  vi.mocked(f.api.collaborations.reviewPrompt).mockImplementationOnce(
    async (_group, _client, input) => ({ ...f.result(input), recipientSessionIds: ['foreign'] }),
  );
  act(() => hook.result.current.reviewContext());
  await waitFor(() => expect(hook.result.current.error).toContain('does not match'));
  expect(hook.result.current.canAttach).toBe(false);
  expect(drafts.getChatDraft(f.draft.id)!.collaborationContext!.input).toBeTruthy();
  expect(drafts.getChatDraft(f.draft.id)!.collaborationContext!.snapshot).toBeUndefined();
});

it('refuses review before POST when its original selectors cannot be persisted', async () => {
  const f = fixture();
  const hook = f.mount();
  f.edit(hook);
  vi.spyOn(drafts, 'saveChatDraft').mockReturnValue(false);
  act(() => hook.result.current.reviewContext());
  await waitFor(() => expect(hook.result.current.error).toContain('Could not retain'));
  expect(f.api.collaborations.reviewPrompt).not.toHaveBeenCalled();
  expect(drafts.getChatDraft(f.draft.id)!.text).toBe('Original editable prompt');
});

it('consumes only the exact accepted one-prompt attachment and preserves its original retry journal', async () => {
  const f = fixture();
  const hook = f.mount();
  f.edit(hook);
  act(() => hook.result.current.reviewContext());
  await waitFor(() => expect(hook.result.current.canAttach).toBe(true));
  act(() => hook.result.current.attach());
  const input = {
    requestId: uuid(95),
    expectedMembershipRevision: f.view.membershipRevision,
    expectedPolicySequence: f.view.policySequence,
    text: 'Explicit first prompt',
    responders: f.options.responders,
    snapshot: hook.result.current.snapshot!,
  };
  const saved = drafts.getChatDraft(f.draft.id)!;
  drafts.saveChatDraft({
    ...saved,
    collaborationSend: { collaborationId: f.view.collaborationId, authScope: 'login', input },
  });
  act(() => hook.result.current.consume(input));
  expect(hook.result.current.snapshot).toBeUndefined();
  expect(hook.result.current.attached).toBe(false);
  expect(drafts.getChatDraft(f.draft.id)!.collaborationContext).toBeUndefined();
  expect(drafts.getChatDraft(f.draft.id)!.collaborationSend!.input).toEqual(input);
  // A late acceptance cannot erase a separately edited next prompt's context.
  f.edit(hook);
  const next = drafts.getChatDraft(f.draft.id)!.collaborationContext;
  act(() => hook.result.current.consume(input));
  expect(drafts.getChatDraft(f.draft.id)!.collaborationContext).toEqual(next);
});

it('blocks automatic attachment reuse when retiring proven accepted context cannot be saved', async () => {
  const f = fixture();
  const hook = f.mount();
  f.edit(hook);
  act(() => hook.result.current.reviewContext());
  await waitFor(() => expect(hook.result.current.canAttach).toBe(true));
  act(() => hook.result.current.attach());
  const input = {
    requestId: uuid(95),
    expectedMembershipRevision: f.view.membershipRevision,
    expectedPolicySequence: f.view.policySequence,
    text: 'Accepted prompt',
    responders: f.options.responders,
    snapshot: hook.result.current.snapshot!,
  };
  vi.spyOn(drafts, 'saveChatDraft').mockReturnValue(false);
  act(() => hook.result.current.consume(input));
  expect(hook.result.current.disabledReason).toContain('Check or review');
  expect(hook.result.current.error).toContain('Could not retain');
  expect(drafts.getChatDraft(f.draft.id)!.collaborationContext!.attached).toBe(true);
});

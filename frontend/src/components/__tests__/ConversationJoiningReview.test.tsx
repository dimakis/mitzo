// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { COLLABORATION_EXECUTION_DISABLED } from '@mitzo/protocol';
import { ConversationAgents } from '../ConversationAgents';
import {
  joiningReviewFixture,
  joiningSetupFixture,
} from '../../preview/conversation-joining-fixture';
import type { LegacyConversationJoiningOwner as ConversationJoiningOwner } from '../../lib/conversation-joining-review';
import { markAuthLost, restoreCookieAuthentication } from '../../lib/api-fetch';
import {
  retainedJoiningReviewFixture,
  retainedLabel,
  retainedPin,
} from '../../lib/__tests__/conversation-joining-retained-fixture';

vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: ({
    onDraftSelectionChange,
  }: {
    onDraftSelectionChange(selection: unknown): void;
  }) => (
    <button type="button" onClick={() => onDraftSelectionChange(joiningSetupFixture().selection)}>
      Choose offline account
    </button>
  ),
}));
vi.mock('../ChatAgentProfilePicker', () => ({
  ChatAgentProfilePicker: () => <span>Default Mitzo</span>,
}));
beforeEach(async () => {
  markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'offline-login' })),
  );
  await restoreCookieAuthentication();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
function mount(options: Partial<ConversationJoiningOwner> = {}) {
  let revision = 1;
  const owner: ConversationJoiningOwner = {
    sourceConversationId: 'source-chat',
    artifacts: joiningReviewFixture().artifactLabels,
    review: vi.fn<ConversationJoiningOwner['review']>(async ({ joiningBrief }) =>
      joiningReviewFixture(
        joiningBrief === undefined
          ? {}
          : {
              joiningBrief,
              snapshotId: `00000000-0000-4000-8000-${String(++revision).padStart(12, '0')}`,
              sha256: 'b'.repeat(64),
            },
      ),
    ),
    confirm: vi.fn<ConversationJoiningOwner['confirm']>(async (input) => ({
      version: 1,
      joinId: '00000000-0000-4000-8000-000000000010',
      name: input.name,
      settings: input.settings,
      snapshot: input.snapshot,
      membershipRevision: input.expectedMembershipRevision,
      allocationOperationId: '00000000-0000-4000-8000-000000000011',
      state: 'pending_preparation',
      sessionId: null,
      linkedFromRevision: null,
      execution: COLLABORATION_EXECUTION_DISABLED,
    })),
    recover: vi.fn(),
    ...options,
  };
  const view = () => (
    <MemoryRouter>
      <ConversationAgents
        scope="source-chat"
        joiningOwner={owner}
        agents={[
          {
            id: 'source-chat',
            name: 'Mitzo',
            state: 'Current conversation',
            policy: { reads: true, replies: true },
          },
        ]}
        messages={[
          {
            messageId: 'message-one',
            role: 'user',
            blocks: [
              {
                blockId: 'block-one',
                blockType: 'text',
                content: 'Keep the plan and the discussion together.',
              },
            ],
          },
        ]}
      />
    </MemoryRouter>
  );
  const rendered = render(view());
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Mitzo' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Name in this chat' }), {
    target: { value: 'Reviewer' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Choose offline account' }));
  fireEvent.click(screen.getByRole('radio', { name: /Mac host/ }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Context' }), {
    target: { value: 'selected' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Purpose' }), {
    target: { value: joiningSetupFixture().purpose },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /Keep the plan/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Chat experience plan/ }));
  return Object.assign(owner, { refreshArtifacts: () => rendered.rerender(view()) });
}

it('selects artifact kinds independently and keeps retained r2 when r3 arrives', async () => {
  let revision = 10;
  const saved = retainedJoiningReviewFixture();
  const owner = mount({
    artifacts: structuredClone(saved.artifactLabels),
    review: vi.fn(async ({ joiningBrief }) => {
      const review = structuredClone(saved);
      if (joiningBrief !== undefined) {
        review.snapshot.joiningBrief = joiningBrief;
        review.snapshot.snapshotId = `00000000-0000-4000-8000-${String(++revision).padStart(12, '0')}`;
        review.snapshot.sha256 = 'b'.repeat(64);
      }
      return review;
    }),
  });
  const inline = screen.getByRole('checkbox', { name: /Chat experience plan/ }) as HTMLInputElement;
  const retained = screen.getByRole('checkbox', {
    name: /Retained review plan/,
  }) as HTMLInputElement;
  expect(inline.checked).toBe(true);
  expect(retained.checked).toBe(false);
  fireEvent.click(retained);
  expect(inline.checked).toBe(true);
  fireEvent.click(retained);
  expect(inline.checked).toBe(true);
  expect(retained.checked).toBe(false);
  fireEvent.click(retained);
  owner.artifacts!.push({
    ...retainedLabel(),
    revision: 3,
    title: 'New r3',
    filename: 'latest.md',
  });
  owner.refreshArtifacts();
  expect(retained.checked).toBe(true);
  expect((screen.getByRole('checkbox', { name: /New r3/ }) as HTMLInputElement).checked).toBe(
    false,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  await screen.findByRole('textbox', { name: /Joining brief · sent to every participant/ });
  expect(owner.review).toHaveBeenCalledWith(
    expect.objectContaining({
      setup: expect.objectContaining({
        artifacts: [...joiningSetupFixture().artifacts, retainedPin()],
      }),
    }),
    expect.any(AbortSignal),
  );
  const included = screen.getByText('Review included context').closest('details')!;
  expect(included.textContent).toContain('Chat experience plan');
  expect(included.textContent).toContain('Retained review plan');
  expect(included.textContent).toContain('Saved version 2 · retained-plan-r2.md');
  expect(included.textContent).toContain('original-author-chat');
  expect(included.textContent).toContain('notes/retained-plan-r2.md');
  expect(included.textContent).not.toContain('latest.md');
  fireEvent.change(
    screen.getByRole('textbox', { name: /Joining brief · sent to every participant/ }),
    {
      target: { value: 'Keep both exact saved versions.' },
    },
  );
  await waitFor(() => expect(owner.review).toHaveBeenCalledTimes(2));
  expect(vi.mocked(owner.review).mock.calls[1][0].setup.artifacts).toEqual([
    ...joiningSetupFixture().artifacts,
    retainedPin(),
  ]);
  fireEvent.click(screen.getByRole('button', { name: /^Back$/ }));
  expect(
    (screen.getByRole('checkbox', { name: /Retained review plan/ }) as HTMLInputElement).checked,
  ).toBe(true);
});
it('follows approved setup, exact artifact selection, context review, editable brief and confirmation', async () => {
  const owner = mount();
  expect(owner.review).not.toHaveBeenCalled();
  expect(owner.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  const dialog = screen.getByRole('dialog', { name: 'Before joining' });
  await within(dialog).findByText('Context for the fresh agent');
  expect(owner.review).toHaveBeenCalledWith(
    expect.objectContaining({
      setup: expect.objectContaining({ artifacts: joiningSetupFixture().artifacts }),
    }),
    expect.any(AbortSignal),
  );
  expect(within(dialog).getByText('1 message · 1 artifact version')).toBeTruthy();
  const included = within(dialog).getByText('Review included context').closest('details')!;
  fireEvent.click(within(dialog).getByText('Review included context'));
  expect(included.textContent).toContain('Chat experience plan');
  expect(included.textContent).toContain('Saved version 2 · chat-experience-plan.md');
  const brief = within(dialog).getByRole('textbox', {
    name: /Joining brief · sent to every participant/,
  });
  fireEvent.change(brief, { target: { value: 'Inspect recovery and attribution.' } });
  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', { name: 'Join conversation' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Join conversation' }));
  await within(dialog).findByText(/Reviewer joining\./);
  expect(owner.confirm).toHaveBeenCalledTimes(1);
  expect((brief as HTMLTextAreaElement).disabled).toBe(true);
  expect(within(dialog).queryByRole('button', { name: 'Join conversation' })).toBeNull();
});
it('preserves setup, edited review and operation across policy inspection and closing', async () => {
  const owner = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  const dialog = screen.getByRole('dialog', { name: 'Before joining' });
  await within(dialog).findByText('Context for the fresh agent');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Shared discussion · Mitzo reply' }));
  expect(screen.getByRole('dialog', { name: 'Agents' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back from joining review' }));
  expect((screen.getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).value).toBe(
    joiningSetupFixture().purpose,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Join conversation' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Close Agents' }));
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Mitzo' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  expect(screen.getByRole('dialog', { name: 'Before joining' })).toBeTruthy();
  expect(owner.confirm).not.toHaveBeenCalled();
});

it('resumes the edited frozen brief after Back and Review with unchanged setup', async () => {
  const owner = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  await screen.findByRole('textbox', { name: /Joining brief · sent to every participant/ });
  fireEvent.change(
    screen.getByRole('textbox', { name: /Joining brief · sent to every participant/ }),
    {
      target: { value: 'Keep this operator-edited joining brief.' },
    },
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Join conversation' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  const refreeze = structuredClone(vi.mocked(owner.review).mock.calls[1][0]);
  fireEvent.click(screen.getByRole('button', { name: /^Back$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole('textbox', {
          name: /Joining brief · sent to every participant/,
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('Keep this operator-edited joining brief.'),
  );
  expect(owner.review).toHaveBeenCalledTimes(2);
  expect(vi.mocked(owner.review).mock.calls[1][0]).toEqual(refreeze);
  fireEvent.click(screen.getByRole('button', { name: 'Join conversation' }));
  await screen.findByText(/Reviewer joining\./);
  expect(vi.mocked(owner.confirm).mock.calls[0][0].snapshot).toEqual({
    snapshotId: '00000000-0000-4000-8000-000000000002',
    sha256: 'b'.repeat(64),
  });
});

it('retains a lost initial review attempt through Close, Agents and Add agent and retries its exact request', async () => {
  const owner = mount();
  vi.mocked(owner.review).mockRejectedValueOnce(new Error('Saved response was lost'));
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  await screen.findByRole('alert');
  const original = structuredClone(vi.mocked(owner.review).mock.calls[0][0]);
  fireEvent.click(screen.getByRole('button', { name: 'Close Agents' }));
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Mitzo' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  const review = screen.getByRole('dialog', { name: 'Before joining' });
  expect(within(review).getByRole('alert')).toBeTruthy();
  expect(owner.review).toHaveBeenCalledTimes(1);
  fireEvent.click(within(review).getByRole('button', { name: 'Check again' }));
  await within(review).findByText('Context for the fresh agent');
  expect(owner.review).toHaveBeenCalledTimes(2);
  expect(vi.mocked(owner.review).mock.calls[1][0]).toEqual(original);
  expect(owner.confirm).not.toHaveBeenCalled();
});

it('invalidates the old brief and frozen source only when setup is explicitly changed', async () => {
  const owner = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  await screen.findByRole('textbox', { name: /Joining brief · sent to every participant/ });
  fireEvent.change(
    screen.getByRole('textbox', { name: /Joining brief · sent to every participant/ }),
    {
      target: { value: 'Earlier operator-edited brief.' },
    },
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Join conversation' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  const earlier = structuredClone(vi.mocked(owner.review).mock.calls[1][0]);
  fireEvent.click(screen.getByRole('button', { name: /^Back$/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Purpose' }), {
    target: { value: 'Check authentication.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  expect(screen.getByRole('dialog', { name: 'Add agent' })).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).value).toBe(
    'Check authentication.',
  );
  vi.mocked(owner.review).mockImplementationOnce(async ({ setup }) =>
    joiningReviewFixture({
      purpose: setup.purpose,
      joiningBrief: 'Fresh review for the changed purpose.',
      snapshotId: '00000000-0000-4000-8000-000000000003',
      sha256: 'c'.repeat(64),
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole('textbox', {
          name: /Joining brief · sent to every participant/,
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('Fresh review for the changed purpose.'),
  );
  const changed = vi.mocked(owner.review).mock.calls[2][0];
  expect(changed.requestId).not.toBe(earlier.requestId);
  expect(changed.setup.purpose).toBe('Check authentication.');
  expect(changed.joiningBrief).toBeUndefined();
  expect(changed.previousSnapshot).toBeUndefined();
  expect(owner.confirm).not.toHaveBeenCalled();
});

it('restores the original editable setup and exact lost review when the actual dialog remounts', async () => {
  const owner = mount();
  vi.mocked(owner.review).mockRejectedValueOnce(new Error('Saved response was lost'));
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  await screen.findByRole('alert');
  const original = structuredClone(vi.mocked(owner.review).mock.calls[0][0]);
  cleanup();
  render(
    <MemoryRouter>
      <ConversationAgents
        scope="source-chat"
        joiningOwner={owner}
        agents={[{ id: 'source-chat', name: 'Mitzo', state: 'Current conversation' }]}
        messages={[]}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Mitzo' }));
  fireEvent.click(screen.getByRole('button', { name: /^Add agent$/ }));
  const review = screen.getByRole('dialog', { name: 'Before joining' });
  expect(owner.review).toHaveBeenCalledTimes(1);
  expect(owner.confirm).not.toHaveBeenCalled();
  fireEvent.click(within(review).getByRole('button', { name: /^Back$/ }));
  expect(
    (screen.getByRole('textbox', { name: 'Name in this chat' }) as HTMLInputElement).value,
  ).toBe(original.setup.name);
  expect((screen.getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).value).toBe(
    original.setup.purpose,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  await waitFor(() => expect(owner.review).toHaveBeenCalledTimes(2));
  expect(vi.mocked(owner.review).mock.calls[1][0]).toEqual(original);
});

it('closes only after linked confirmation and offers the next agent a fresh editable setup', async () => {
  const owner = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Join conversation' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Join conversation' }));
  await screen.findByText(/Reviewer joining\./);
  const input = vi.mocked(owner.confirm).mock.calls[0][0];
  vi.mocked(owner.recover).mockResolvedValueOnce({
    version: 1,
    joinId: '00000000-0000-4000-8000-000000000010',
    name: input.name,
    settings: input.settings,
    snapshot: input.snapshot,
    membershipRevision: input.expectedMembershipRevision,
    allocationOperationId: '00000000-0000-4000-8000-000000000011',
    state: 'linked',
    sessionId: 'fresh-chat',
    linkedFromRevision: 1,
    execution: COLLABORATION_EXECUTION_DISABLED,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Mitzo' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  expect(screen.getByRole('dialog', { name: 'Add agent' })).toBeTruthy();
  expect(
    (screen.getByRole('textbox', { name: 'Name in this chat' }) as HTMLInputElement).value,
  ).toBe('');
  expect((screen.getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).value).toBe('');
  expect(
    screen.getByRole('button', { name: 'Review joining brief' }).hasAttribute('disabled'),
  ).toBe(true);
});

it('rechecks a restored linked receipt before retiring it for another fresh agent', async () => {
  const owner = mount();
  let linked: import('@mitzo/protocol').CollaborationJoin | undefined;
  vi.mocked(owner.confirm).mockImplementationOnce(async (input) => {
    linked = {
      version: 1,
      joinId: '00000000-0000-4000-8000-000000000010',
      name: input.name,
      settings: input.settings,
      snapshot: input.snapshot,
      membershipRevision: input.expectedMembershipRevision,
      allocationOperationId: '00000000-0000-4000-8000-000000000011',
      state: 'linked',
      sessionId: 'prepared-reviewer',
      linkedFromRevision: input.expectedMembershipRevision,
      execution: COLLABORATION_EXECUTION_DISABLED,
    };
    return linked;
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Join conversation' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Join conversation' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  cleanup();
  render(
    <MemoryRouter>
      <ConversationAgents
        scope="source-chat"
        joiningOwner={owner}
        agents={[{ id: 'source-chat', name: 'Mitzo', state: 'Current conversation' }]}
        messages={[]}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Mitzo' }));
  fireEvent.click(screen.getByRole('button', { name: /^Add agent$/ }));
  const review = screen.getByRole('dialog', { name: 'Before joining' });
  expect(owner.confirm).toHaveBeenCalledTimes(1);
  expect(owner.recover).not.toHaveBeenCalled();
  vi.mocked(owner.recover).mockResolvedValueOnce(linked!);
  fireEvent.click(within(review).getByRole('button', { name: 'Check again' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Mitzo' }));
  fireEvent.click(screen.getByRole('button', { name: /^Add agent$/ }));
  expect(screen.getByRole('dialog', { name: 'Add agent' })).toBeTruthy();
  expect(
    (screen.getByRole('textbox', { name: 'Name in this chat' }) as HTMLInputElement).value,
  ).toBe('');
  expect(owner.confirm).toHaveBeenCalledTimes(1);
});

it.each(['review', 'uncertain', 'linked'] as const)(
  'restores the actual dialog’s original %s setup when its owner arrives late',
  async (kind) => {
    const owner = mount();
    let linked: import('@mitzo/protocol').CollaborationJoin | undefined;
    if (kind === 'review') vi.mocked(owner.review).mockRejectedValueOnce(new Error('Lost review'));
    if (kind === 'uncertain')
      vi.mocked(owner.confirm).mockRejectedValueOnce(new Error('Lost confirmation'));
    if (kind === 'linked')
      vi.mocked(owner.confirm).mockImplementationOnce(async (input) => {
        linked = {
          version: 1,
          joinId: '00000000-0000-4000-8000-000000000010',
          allocationOperationId: '00000000-0000-4000-8000-000000000011',
          name: input.name,
          membershipRevision: input.expectedMembershipRevision,
          settings: input.settings,
          snapshot: input.snapshot,
          state: 'linked',
          sessionId: 'prepared-reviewer',
          linkedFromRevision: input.expectedMembershipRevision,
          execution: COLLABORATION_EXECUTION_DISABLED,
        };
        return linked;
      });
    fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
    if (kind === 'review') await screen.findByRole('alert');
    else {
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Join conversation' }).hasAttribute('disabled'),
        ).toBe(false),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Join conversation' }));
      if (kind === 'uncertain') await screen.findByRole('alert');
      else await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    const original = structuredClone(vi.mocked(owner.review).mock.calls[0][0]);
    const submission =
      kind === 'review' ? undefined : structuredClone(vi.mocked(owner.confirm).mock.calls[0][0]);
    cleanup();
    const element = (available: boolean) => (
      <MemoryRouter>
        <ConversationAgents
          scope="source-chat"
          joiningOwner={available ? owner : undefined}
          agents={[{ id: 'source-chat', name: 'Mitzo', state: 'Current conversation' }]}
          messages={[]}
        />
      </MemoryRouter>
    );
    const dialog = render(element(false));
    dialog.rerender(element(true));
    expect(owner.review).toHaveBeenCalledTimes(1);
    expect(owner.confirm).toHaveBeenCalledTimes(kind === 'review' ? 0 : 1);
    fireEvent.click(screen.getByRole('button', { name: 'Agents, Mitzo' }));
    fireEvent.click(screen.getByRole('button', { name: /^Add agent$/ }));
    expect(screen.getByRole('dialog', { name: 'Before joining' })).toBeTruthy();
    if (kind === 'review') {
      fireEvent.click(screen.getByRole('button', { name: /^Back$/ }));
      expect(
        (screen.getByRole('textbox', { name: 'Name in this chat' }) as HTMLInputElement).value,
      ).toBe(original.setup.name);
      expect((screen.getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).value).toBe(
        original.setup.purpose,
      );
      fireEvent.change(screen.getByRole('textbox', { name: 'Name in this chat' }), {
        target: { value: 'ExplicitlyEdited' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.click(screen.getByRole('button', { name: /^Add agent$/ }));
      expect(
        (screen.getByRole('textbox', { name: 'Name in this chat' }) as HTMLInputElement).value,
      ).toBe('ExplicitlyEdited');
    } else if (kind === 'uncertain') {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      await waitFor(() => expect(owner.confirm).toHaveBeenCalledTimes(2));
      expect(vi.mocked(owner.confirm).mock.calls[1][0]).toEqual(submission);
    } else {
      vi.mocked(owner.recover).mockResolvedValueOnce(linked!);
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(owner.recover).toHaveBeenCalledWith(linked!.joinId, expect.any(AbortSignal));
      expect(owner.confirm).toHaveBeenCalledTimes(1);
    }
  },
);

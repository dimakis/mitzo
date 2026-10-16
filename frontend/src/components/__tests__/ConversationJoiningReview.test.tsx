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
import type { ConversationJoiningOwner } from '../../lib/conversation-joining-review';

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
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);
function mount() {
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
  };
  render(
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
    </MemoryRouter>,
  );
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
  return owner;
}
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

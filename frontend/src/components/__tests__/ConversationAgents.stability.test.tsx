// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ConversationAgents, type ConversationAgent } from '../ConversationAgents';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../AccountModelPicker', () => ({ AccountModelPicker: () => null }));
vi.mock('../ChatAgentProfilePicker', () => ({ ChatAgentProfilePicker: () => null }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);
const agent: ConversationAgent = {
  id: 'reviewer',
  name: 'Reviewer',
  account: 'Personal',
  model: 'Astra',
  profile: 'Default Mitzo · revision 1',
  mode: 'agent',
  membership: 'joined',
  membershipLabel: 'Member',
  state: 'Working',
  policy: { reads: false, replies: true },
};
const tree = (agents: ConversationAgent[]) => (
  <ConversationAgents scope="chat" agents={agents} messages={[]} onPolicyChange={() => {}} />
);

it('keeps the same focused row through streaming status updates and returns from Details to its trigger', () => {
  const result = render(tree([agent]));
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Reviewer' }));
  const details = screen.getByRole('button', { name: 'Details for Reviewer' });
  details.focus();
  result.rerender(
    tree([{ ...agent, state: 'Reading a very long tool description while streaming' }]),
  );
  expect(screen.getByRole('button', { name: 'Details for Reviewer' })).toBe(details);
  expect(document.activeElement).toBe(details);
  result.rerender(
    tree([
      {
        id: agent.id,
        name: agent.name,
        membership: 'joined',
        membershipLabel: 'Member',
        state: 'Not observed',
      },
    ]),
  );
  fireEvent.click(details);
  const dialog = screen.getByRole('dialog', { name: 'Reviewer' });
  expect(within(dialog).getByText('Default Mitzo · revision 1')).toBeTruthy();
  expect(within(dialog).getByText('agent')).toBeTruthy();
  expect(within(dialog).getByText('Member')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back to Agents' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Details for Reviewer' }));
});

it('keeps a selected missing seat discoverable without live policy controls and gives a way back', () => {
  const result = render(tree([agent]));
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Reviewer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Details for Reviewer' }));
  result.rerender(tree([]));
  expect(screen.getByRole('dialog', { name: 'Reviewer' })).toBeTruthy();
  expect(screen.getByText('Astra')).toBeTruthy();
  expect(screen.getByText(/No longer in this roster/)).toBeTruthy();
  expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Back to Agents' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add agent' }));
});

it('renders unavailable joined membership without deriving controls from its display label', () => {
  const draftProfile = vi.fn();
  const current = {
    ...agent,
    membershipLabel: 'Member · unavailable',
    state: 'Not observed',
    policy: undefined,
  };
  render(
    <ConversationAgents
      scope="chat"
      agents={[current]}
      messages={[]}
      onDraftProfile={draftProfile}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Reviewer' }));
  expect(screen.getByText('Member · unavailable · Not observed')).toBeTruthy();
  expect(
    screen.getAllByRole('checkbox').every((input) => (input as HTMLInputElement).disabled),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Details for Reviewer' }));
  expect(screen.getByText('Member · unavailable')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Draft reusable profile from this agent' }));
  expect(draftProfile).toHaveBeenCalledWith('reviewer');
});

it('keeps retained removed rows stable with history and original recovery but no live controls', () => {
  const checkOriginalStop = vi.fn();
  const actions = vi.fn((seat: ConversationAgent) =>
    seat.membership === 'removed' ? null : <button type="button">Remove Reviewer</button>,
  );
  const recovery = vi.fn((seat: ConversationAgent) =>
    seat.membership === 'removed' ? (
      <button type="button" onClick={checkOriginalStop}>
        Check original Stop
      </button>
    ) : null,
  );
  const retainedTree = (seat: ConversationAgent) => (
    <MemoryRouter>
      <ConversationAgents
        scope="chat"
        agents={[seat]}
        messages={[]}
        onPolicyChange={vi.fn()}
        onPreview={vi.fn()}
        onDraftProfile={vi.fn()}
        onRefresh={vi.fn()}
        renderAgentActions={actions}
        renderAgentResult={recovery}
      />
    </MemoryRouter>
  );
  const result = render(retainedTree({ ...agent, historySessionId: agent.id }));
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Reviewer' }));
  const details = screen.getByRole('button', { name: 'Details for Reviewer' });
  const row = details.closest('article');
  details.focus();
  // Keep stale live policy and misleading display text deliberately: lifecycle
  // controls must depend on typed membership, never labels or prior props.
  result.rerender(
    retainedTree({
      ...agent,
      membership: 'removed',
      membershipLabel: 'Member',
      historySessionId: agent.id,
    }),
  );
  expect(details.closest('article')).toBe(row);
  expect(document.activeElement).toBe(details);
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Preview Reviewer conversation' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove Reviewer' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Open Reviewer history' }).getAttribute('href')).toBe(
    '/chat/reviewer',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check original Stop' }));
  expect(checkOriginalStop).toHaveBeenCalledOnce();
  expect(recovery).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: agent.id, membership: 'removed' }),
  );
  fireEvent.click(details);
  expect(screen.getByText('Removed from roster')).toBeTruthy();
  expect(screen.getByText('Astra')).toBeTruthy();
  expect(screen.getByText('Default Mitzo · revision 1')).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Draft reusable profile from this agent' }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Refresh agent status' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Back to Agents' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Details for Reviewer' }));
  expect(screen.getByRole('button', { name: 'Check original Stop' })).toBeTruthy();
});

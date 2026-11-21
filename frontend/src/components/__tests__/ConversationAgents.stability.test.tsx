// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ConversationAgents, type ConversationAgent } from '../ConversationAgents';

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
  membership: 'Member',
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
    tree([{ id: agent.id, name: agent.name, membership: 'Member', state: 'Not observed' }]),
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

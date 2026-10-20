// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConversationAgents } from '../ConversationAgents';

vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: () => (
    <label>
      Account
      <select aria-label="Account">
        <option>Work account</option>
      </select>
    </label>
  ),
}));
vi.mock('../ChatAgentProfilePicker', () => ({
  ChatAgentProfilePicker: () => (
    <label>
      Agent
      <select aria-label="Agent">
        <option>Default Mitzo</option>
      </select>
    </label>
  ),
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
const agents = [
  { id: 'primary', name: 'Primary agent', account: 'Work account', model: 'Luna', state: 'Added' },
];
const messages = [
  {
    messageId: 'm1',
    role: 'user' as const,
    blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'Review the layout.' }],
  },
];
function mount(extra = {}) {
  return render(
    <MemoryRouter>
      <ConversationAgents scope="chat-one" agents={agents} messages={messages} {...extra} />
    </MemoryRouter>,
  );
}
it('uses one compact participant header and one Agents view without transcript tabs', () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Primary agent' }));
  const dialog = screen.getByRole('dialog', { name: 'Agents' });
  expect(within(dialog).getByText('Primary agent')).toBeTruthy();
  expect(
    within(dialog)
      .getByRole('checkbox', { name: 'Reads future discussion' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(
    within(dialog).getByRole('checkbox', { name: 'Replies by default' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.queryByText('Accounts and models per agent')).toBeNull();
});
it('keeps fresh-agent setup in the same view, with purpose and full or selected context, without allocating', () => {
  const preview = vi.fn();
  mount({ onPreview: preview });
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Primary agent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  const dialog = screen.getByRole('dialog', { name: 'Add agent' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name in this chat' }), {
    target: { value: 'Reviewer' },
  });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Purpose' }), {
    target: { value: 'Check the design.' },
  });
  fireEvent.change(within(dialog).getByRole('combobox', { name: 'Context' }), {
    target: { value: 'selected' },
  });
  expect(within(dialog).getByText('Joining brief only.')).toBeTruthy();
  expect(within(dialog).getByRole('checkbox', { name: /Review the layout/ })).toBeTruthy();
  expect(
    within(dialog).getByRole('button', { name: 'Review joining brief' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.queryByRole('tab', { name: 'Existing chat' })).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  expect((screen.getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).value).toBe(
    'Check the design.',
  );
  expect(preview).not.toHaveBeenCalled();
});
it('applies real policy edits only through the supplied owner and keeps preview separate from recipients', () => {
  const change = vi.fn(),
    preview = vi.fn();
  mount({
    agents: [{ ...agents[0], policy: { reads: false, replies: true } }],
    onPolicyChange: change,
    onPreview: preview,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Primary agent' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Reads future discussion' }));
  expect(change).toHaveBeenCalledWith('primary', { reads: true, replies: true });
  fireEvent.click(screen.getByRole('button', { name: 'Preview Primary agent conversation' }));
  expect(preview).toHaveBeenCalledWith('primary');
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('clears another conversation’s setup and closes on scope change', () => {
  const view = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Primary agent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Purpose' }), {
    target: { value: 'Private purpose' },
  });
  view.rerender(
    <MemoryRouter>
      <ConversationAgents scope="chat-two" agents={agents} messages={[]} />
    </MemoryRouter>,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Primary agent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  expect((screen.getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).value).toBe('');
});

it('keeps account/model details and reusable-profile drafting on the selected agent', () => {
  const draft = vi.fn();
  mount({ onDraftProfile: draft });
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Primary agent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Details for Primary agent' }));
  const dialog = screen.getByRole('dialog', { name: 'Primary agent' });
  expect(within(dialog).getByText('Work account')).toBeTruthy();
  expect(within(dialog).getByText('Luna')).toBeTruthy();
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Draft reusable profile from this agent' }),
  );
  expect(draft).toHaveBeenCalledWith('primary');
});

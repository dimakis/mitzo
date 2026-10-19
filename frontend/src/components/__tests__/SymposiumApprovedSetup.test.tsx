// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConversationAgents } from '../ConversationAgents';

vi.mock('../AccountModelPicker', () => ({ AccountModelPicker: () => <span>Account picker</span> }));
vi.mock('../ChatAgentProfilePicker', () => ({
  ChatAgentProfilePicker: () => <span>Agent picker</span>,
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

it('registers the existing human approval and the original fresh-agent references', () => {
  const ledger = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../docs/design/approved/ledger.json'), 'utf8'),
  );
  const surface = ledger.surfaces.find(
    (entry: { id: string }) => entry.id === 'symposium-fresh-agent',
  );
  expect(
    surface,
    'the accepted fresh-agent design needs its own protected ledger entry',
  ).toBeDefined();
  const active = surface.revisions.find(
    (entry: { id: string }) => entry.id === surface.activeRevision,
  );
  expect(active.approval.thread).toBe('01a13ea4-6c32-7af0-b635-c3f5f56aecb5');
  expect(active.approval.quote).toBe(
    'Looks decent. Let’s update telos and give a handover to start',
  );
  expect(active.references).toEqual([
    {
      path: 'docs/design/approved/symposium/fresh-agent-review.html',
      sha256: '175e801ff2acd66cd8d176d56bd389da9439d75a4cf061e214b4220357894bbc',
    },
    {
      path: 'docs/design/approved/symposium/approved-context-review.png',
      sha256: 'b79c58c7bb7f7d45568def98150f401441b93aead7aae71a389f44f6d992c64a',
    },
  ]);
});

it('retains the approved fresh setup footer, runtime order and actual repository without allocation', () => {
  render(
    <MemoryRouter>
      <ConversationAgents
        scope="ordinary-one"
        agents={[{ id: 'ordinary-one', name: 'Architect', state: 'Idle' }]}
        messages={[]}
        repository="dimakis/mitzo"
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Architect' }));
  fireEvent.click(screen.getByRole('button', { name: /^Add agent$/ }));
  const add = screen.getByRole('dialog', { name: /^Add agent$/ });
  expect(
    within(add)
      .getAllByRole('radio')
      .map((radio) => radio.getAttribute('value')),
  ).toEqual(['local', 'openshell']);
  expect(within(add).getByText('dimakis/mitzo', { exact: true })).toBeTruthy();
  const footer = add.querySelector('footer')!;
  expect(
    within(footer).getByText('Fresh session · starts with a prompt.', { exact: true }),
  ).toBeTruthy();
  expect(
    within(footer)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['Cancel', 'Review joining brief']);
  expect(
    within(footer).getByRole('button', { name: 'Review joining brief' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.change(within(add).getByRole('textbox', { name: 'Purpose' }), {
    target: { value: 'Check this exact draft.' },
  });
  fireEvent.click(within(footer).getByRole('button', { name: /^Cancel$/ }));
  expect(screen.getByRole('dialog', { name: /^Agents$/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^Add agent$/ }));
  expect((screen.getByRole('textbox', { name: 'Purpose' }) as HTMLTextAreaElement).value).toBe(
    'Check this exact draft.',
  );
});

// @vitest-environment jsdom
import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConversationAgents } from '../ConversationAgents';
vi.mock('../AccountModelPicker', () => ({ AccountModelPicker: () => null }));
vi.mock('../ChatAgentProfilePicker', () => ({ ChatAgentProfilePicker: () => null }));
const showModal = HTMLDialogElement.prototype.showModal;
const close = HTMLDialogElement.prototype.close;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);
afterAll(() => {
  HTMLDialogElement.prototype.showModal = showModal;
  HTMLDialogElement.prototype.close = close;
});

it('keeps confirmed-policy refusal and an explicit refresh reachable inside Agents', () => {
  const refresh = vi.fn();
  render(
    <MemoryRouter>
      <ConversationAgents
        scope="policy-dialog"
        agents={[
          { id: 'one', name: 'Architect', state: 'Added', policy: { reads: true, replies: false } },
        ]}
        messages={[]}
        policyFeedback={
          <>
            <p role="alert">Membership changed.</p>
            <button onClick={refresh}>Refresh sharing</button>
          </>
        }
        policyUnavailableReason="Refresh discussion sharing before changing it."
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Architect' }));
  const dialog = screen.getByRole('dialog', { name: 'Agents' });
  expect(within(dialog).getByRole('alert').textContent).toBe('Membership changed.');
  expect(within(dialog).getByText('Refresh discussion sharing before changing it.')).toBeTruthy();
  expect(
    (within(dialog).getByRole('checkbox', { name: 'Reads future discussion' }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(
    (within(dialog).getByRole('checkbox', { name: 'Reads future discussion' }) as HTMLInputElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh sharing' }));
  expect(refresh).toHaveBeenCalledOnce();
});

it('shows a pending policy explanation without changing the checkbox’s confirmed value', () => {
  render(
    <MemoryRouter>
      <ConversationAgents
        scope="pending-policy"
        agents={[
          { id: 'one', name: 'Architect', state: 'Added', policy: { reads: false, replies: true } },
        ]}
        messages={[]}
        policyFeedback={<p role="status">Saving discussion sharing choices…</p>}
        policyUnavailableReason="Waiting for the original policy request."
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Architect' }));
  const dialog = screen.getByRole('dialog', { name: 'Agents' });
  expect(within(dialog).getByRole('status').textContent).toBe('Saving discussion sharing choices…');
  expect(
    (within(dialog).getByRole('checkbox', { name: 'Reads future discussion' }) as HTMLInputElement)
      .checked,
  ).toBe(false);
});

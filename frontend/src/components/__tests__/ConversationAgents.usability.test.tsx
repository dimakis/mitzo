// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ConversationAgents } from '../ConversationAgents';
import { markAuthLost, restoreCookieAuthentication } from '../../lib/api-fetch';

vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: ({
    onDraftSelectionChange,
  }: {
    onDraftSelectionChange(value: unknown): void;
  }) => (
    <button
      type="button"
      onClick={() => onDraftSelectionChange({ accountId: 'account', model: 'model' })}
    >
      Choose account and model
    </button>
  ),
}));
vi.mock('../ChatAgentProfilePicker', () => ({
  ChatAgentProfilePicker: () => <span>Default Mitzo</span>,
}));
vi.mock('../ConversationRepositoryPicker', () => ({
  ConversationRepositoryPicker: ({ onChange }: { onChange(value: unknown): void }) => (
    <>
      <button type="button" onClick={() => onChange({ repositoryBlocked: true })}>
        Clear repository
      </button>
      <button
        type="button"
        onClick={() =>
          onChange({ repositoryWorkspaceId: 'fresh-workspace', repositoryBlocked: false })
        }
      >
        Use current repository
      </button>
      <button
        type="button"
        onClick={() =>
          onChange({
            repositoryWorkspaceId: 'pending-workspace',
            permissionMode: 'agent',
            repositoryBlocked: true,
          })
        }
      >
        Prepare repository
      </button>
    </>
  ),
}));
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'usability-login' })),
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
  vi.unstubAllGlobals();
});

function mount() {
  const captureReview = vi.fn(async () => {
    throw Error('Synthetic capture refusal');
  });
  render(
    <MemoryRouter>
      <ConversationAgents
        scope="source"
        messages={[]}
        agents={[{ id: 'source', name: 'Mitzo', state: 'Current conversation' }]}
        joiningOwner={{
          kind: 'application',
          sourceConversationId: 'source',
          collaborationId: '00000000-0000-4000-8000-000000000001',
          captureReview,
          review: vi.fn(),
          confirm: vi.fn(),
          recover: vi.fn(),
        }}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Mitzo' }));
  return captureReview;
}

it('represents unknown sharing as unknown instead of two apparently off checkboxes', () => {
  mount();
  expect(screen.getByText('Sharing settings have not been checked.')).toBeTruthy();
  for (const input of screen.getAllByRole('checkbox')) {
    expect(input.getAttribute('aria-checked')).toBe('mixed');
    expect((input as HTMLInputElement).indeterminate).toBe(true);
    expect((input as HTMLInputElement).disabled).toBe(true);
  }
  expect(screen.getByText(/You can still send selected earlier messages/)).toBeTruthy();
});

it('explains missing setup and submits the pinned Default Mitzo after repository preparation', async () => {
  const captureReview = mount();
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  const dialog = screen.getByRole('dialog', { name: 'Add agent' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name in this chat' }), {
    target: { value: 'Bob' },
  });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Purpose' }), {
    target: { value: 'Review the plan' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Choose account and model' }));
  fireEvent.click(within(dialog).getByRole('button', { name: /Where it runs,/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Clear repository' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
  expect(within(dialog).getByText('Choose a repository in Where it runs.')).toBeTruthy();
  expect(
    (within(dialog).getByRole('button', { name: 'Review joining brief' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  const purpose = within(dialog).getByRole('textbox', { name: 'Purpose' });
  expect(
    purpose.compareDocumentPosition(within(dialog).getByText('Default Mitzo')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: /Where it runs,/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Use current repository' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
  expect(
    (within(dialog).getByRole('button', { name: 'Review joining brief' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Review joining brief' }));
  await waitFor(() => expect(captureReview).toHaveBeenCalledOnce());
  expect(captureReview).toHaveBeenCalledWith(
    expect.objectContaining({
      setup: expect.objectContaining({
        agent: { kind: 'builtin', profileId: 'default-mitzo', revision: 1 },
      }),
    }),
    expect.any(AbortSignal),
  );
  diagnostic.mockRestore();
});

it('keeps review disabled while repository preparation is pending and exposes permission choices', async () => {
  const captureReview = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  const dialog = screen.getByRole('dialog', { name: 'Add agent' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name in this chat' }), {
    target: { value: 'Bob' },
  });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Purpose' }), {
    target: { value: 'Review the plan' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Choose account and model' }));
  fireEvent.click(within(dialog).getByRole('button', { name: /Where it runs,/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Prepare repository' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
  expect(
    (within(dialog).getByRole('button', { name: 'Review joining brief' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(within(dialog).getByText(/repository preparation/i)).toBeTruthy();
  expect(captureReview).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: /Where it runs,/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Use current repository' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
  fireEvent.click(within(dialog).getByRole('button', { name: /^Permissions,/ }));
  for (const mode of ['Ask', 'Agent', 'Auto'])
    expect(within(dialog).getByRole('button', { name: new RegExp(`^${mode}$`) })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: /^Auto$/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  fireEvent.click(within(dialog).getByRole('button', { name: 'Review joining brief' }));
  await waitFor(() => expect(captureReview).toHaveBeenCalledOnce());
  expect(captureReview).toHaveBeenCalledWith(
    expect.objectContaining({
      setup: expect.objectContaining({ permissionMode: 'auto' }),
    }),
    expect.any(AbortSignal),
  );
  diagnostic.mockRestore();
});

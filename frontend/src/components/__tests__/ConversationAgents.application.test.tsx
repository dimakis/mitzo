// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ConversationAgents } from '../ConversationAgents';
import { useConversationJoiningApplication } from '../../hooks/useConversationJoiningApplication';
import { joiningApplicationHarness } from '../../test-utils/conversation-joining-application-harness';
import * as auth from '../../lib/api-fetch';

const selection = { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' };
vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: ({
    onDraftSelectionChange,
  }: {
    onDraftSelectionChange(value: unknown): void;
  }) => (
    <button type="button" onClick={() => onDraftSelectionChange(selection)}>
      Choose offline account
    </button>
  ),
}));
vi.mock('../ChatAgentProfilePicker', () => ({
  ChatAgentProfilePicker: ({ onChange }: { onChange(value: unknown): void }) => (
    <button type="button" onClick={() => onChange({ profileId: 'agent', revision: 1 })}>
      Choose offline agent
    </button>
  ),
}));
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  auth.markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'target-owner-login' })),
  );
  await auth.restoreCookieAuthentication();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  const h = joiningApplicationHarness();
  function Body() {
    const app = useConversationJoiningApplication({
      sourceConversationId: 'source-chat',
      clientId: 'live-client',
      routeKey: 'route-a',
    });
    return (
      <MemoryRouter>
        <ConversationAgents
          scope="source-chat"
          conversationTitle="Chat UI review"
          agents={[{ id: 'source-chat', name: 'Mitzo', state: 'Current conversation' }]}
          messages={[]}
          joiningOwner={app.owner}
          joiningCatalog={app.catalog}
          onAddAgent={() => void app.add()}
          unavailableReason={app.reason}
          onRetryJoiningSetup={app.canRetry ? app.retry : undefined}
        />
      </MemoryRouter>
    );
  }
  render(<Body />);
  return h;
}
async function fill() {
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Mitzo' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose offline account' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose offline agent' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Mac host' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Name in this chat' }), {
    target: { value: 'Reviewer' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Purpose' }), {
    target: { value: 'Keep the exact reviewed context.' },
  });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Review joining brief' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
}

it('drives Add and the existing Review control through actual private adapters without inference or fake capacity', async () => {
  const h = mount();
  await waitFor(() =>
    expect(h.transport.mock.calls.some(([url]) => url.endsWith('/source-catalog'))).toBe(true),
  );
  expect(
    h.transport.mock.calls.some(([url]) => /\/(begin|preview|prepare|reviews|joins)$/.test(url)),
  ).toBe(false);
  await fill();
  const begin = h.journal.readBegin();
  expect(begin).not.toBeNull();
  expect(h.journal.readTarget()).toBeNull();
  expect(h.transport.mock.calls.filter(([url]) => url.endsWith('/begin'))).toHaveLength(1);
  expect(screen.getByText('dimakis/mitzo')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  await screen.findByText('Context for the fresh agent');
  expect(h.journal.readTarget()?.phase).toBe('resolved');
  expect(
    (screen.getByRole('button', { name: 'Join conversation' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByText('Native capacity remains unavailable')).toBeTruthy();
  expect(h.transport.mock.calls.some(([url]) => url.includes('/joins'))).toBe(false);
  const before = h.transport.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: /^Back$/ }));
  expect((screen.getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).value).toBe(
    'Keep the exact reviewed context.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  await screen.findByText('Context for the fresh agent');
  expect(h.transport).toHaveBeenCalledTimes(before);
});

it('retains the original unknown preview through Close and explicit recovery without a second resource', async () => {
  const h = mount();
  h.lose('preview-after');
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  await screen.findByRole('alert');
  const original = h.journal.readTarget()!;
  fireEvent.click(screen.getByRole('button', { name: 'Close Agents' }));
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Mitzo' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  expect(screen.getByRole('dialog', { name: 'Before joining' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await screen.findByText('Context for the fresh agent');
  expect(h.journal.readTarget()!.preview).toEqual(original.preview);
  expect(h.journal.readTarget()!.draft.id).toBe(original.draft.id);
  expect(h.transport.mock.calls.filter(([url]) => url.endsWith('/preview'))).toHaveLength(1);
  expect(h.transport.mock.calls.filter(([url]) => url.endsWith('/prepare'))).toHaveLength(0);
  expect(
    (screen.getByRole('button', { name: 'Join conversation' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

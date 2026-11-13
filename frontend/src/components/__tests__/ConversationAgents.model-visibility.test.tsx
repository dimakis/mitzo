// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ConversationAgents } from '../ConversationAgents';
import { apiFetch, markAuthLost, restoreCookieAuthentication } from '../../lib/api-fetch';
import { setHiddenPickerModels } from '../../lib/model-visibility';
import { joiningReviewFixture } from '../../preview/conversation-joining-fixture';
import type { LegacyConversationJoiningOwner } from '../../lib/conversation-joining-review';

vi.mock('../../lib/api-fetch', async (original) => ({
  ...(await original<typeof import('../../lib/api-fetch')>()),
  apiFetch: vi.fn(),
}));
vi.mock('../ChatAgentProfilePicker', () => ({
  ChatAgentProfilePicker: () => <span>Default Mitzo</span>,
}));
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'visibility-login' })),
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
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('blocks Add agent after switching to an account with no shown models, then reviews the newly selected account', async () => {
  vi.mocked(apiFetch).mockImplementation(async () =>
    Response.json([
      { id: 'account-a', label: 'Account A', models: [{ id: 'model-a', label: 'Model A' }] },
      { id: 'account-b', label: 'Account B', models: [{ id: 'model-b', label: 'Model B' }] },
    ]),
  );
  setHiddenPickerModels('account-b', ['model-b']);
  const owner: LegacyConversationJoiningOwner = {
    sourceConversationId: 'source-chat',
    artifacts: [],
    review: vi.fn<LegacyConversationJoiningOwner['review']>(async ({ setup }) => {
      const result = joiningReviewFixture();
      return {
        ...result,
        snapshot: {
          ...result.snapshot,
          purpose: setup.purpose,
          mode: setup.context,
          messages: [],
          artifacts: [],
        },
        settings: {
          ...result.settings,
          binding: {
            ...result.settings.binding,
            account: { ...result.settings.binding.account, accountId: setup.selection!.accountId! },
          },
          selection: {
            ...result.settings.selection,
            model: setup.selection!.model,
            thinking: null,
          },
        },
      };
    }),
    confirm: vi.fn(),
    recover: vi.fn(),
  };
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
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Name in this chat' }), {
    target: { value: 'Reviewer' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Purpose' }), {
    target: { value: 'Check the design.' },
  });
  fireEvent.click(screen.getByRole('radio', { name: /Mac host/ }));
  const account = await screen.findByRole('combobox', { name: 'Account' });
  const review = screen.getByRole('button', { name: 'Review joining brief' });
  await waitFor(() => expect((review as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(account, { target: { value: 'account-b' } });
  expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('');
  expect((review as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(review);
  expect(owner.review).not.toHaveBeenCalled();
  expect(owner.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Model picker settings' }));
  const settings = screen.getByRole('dialog', { name: 'Model picker settings' });
  fireEvent.click(within(settings).getByRole('button', { name: 'Show all' }));
  fireEvent.click(within(settings).getByRole('button', { name: 'Done' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
    target: { value: 'model-b' },
  });
  await waitFor(() => expect((review as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(review);
  await waitFor(() => expect(owner.review).toHaveBeenCalledOnce());
  await within(screen.getByRole('dialog', { name: 'Before joining' })).findByText(
    'Context for the fresh agent',
  );
  expect(owner.review).toHaveBeenCalledWith(
    expect.objectContaining({
      setup: expect.objectContaining({
        selection: expect.objectContaining({ accountId: 'account-b', model: 'model-b' }),
      }),
    }),
    expect.any(AbortSignal),
  );
  expect(owner.confirm).not.toHaveBeenCalled();
});

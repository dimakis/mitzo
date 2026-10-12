// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { DraftsView } from '../DraftsView';
import {
  createChatDraft,
  saveChatDraft,
  listChatDrafts,
  getChatDraft,
  deleteChatDraft,
} from '../../lib/chat-drafts';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
it.each(['Keep draft', 'Close'])(
  'restores focus after %s when another tab removed the original row',
  async (action) => {
    const draft = { ...createChatDraft(), text: 'Removed elsewhere' };
    saveChatDraft(draft);
    render(
      <MemoryRouter>
        <DraftsView />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    act(() => {
      deleteChatDraft(draft.id);
    });
    fireEvent.click(screen.getByRole('button', { name: action }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('link', { name: /New chat/ })),
    );
  },
);
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.mocked(apiFetch).mockReset();
  vi.restoreAllMocks();
});
it('restores confirmed discard focus after commit without waiting for an animation frame', async () => {
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
  const draft = { ...createChatDraft(), text: 'Discard this thought' };
  saveChatDraft(draft);
  render(
    <MemoryRouter>
      <DraftsView />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm discard' }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /New chat/ })),
  );
});
it('retains a repository-only draft during cleanup and prevents duplicate confirmations', async () => {
  const draft = createChatDraft();
  draft.settings.selection = { accountId: 'work', model: 'model-a' };
  draft.settings.repositoryWorkspaceId = '8ca30b0d-3e65-4eeb-8244-f6277350818f';
  saveChatDraft(draft);
  let resolveDelete!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (_url, options) =>
    options?.method === 'DELETE'
      ? new Promise((resolve) => {
          resolveDelete = resolve;
        })
      : new Response(JSON.stringify({ id: draft.settings.repositoryWorkspaceId, state: 'ready' })),
  );
  render(
    <MemoryRouter>
      <DraftsView />
    </MemoryRouter>,
  );
  expect(screen.getByText('Repository preparation saved.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm discard' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  const pending = screen.getByRole('button', { name: 'Discarding…' }) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  fireEvent.click(pending);
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(getChatDraft(draft.id)).not.toBeNull();
  resolveDelete(new Response(JSON.stringify({ discarded: true })));
  await waitFor(() => expect(screen.getByText('No drafts yet')).toBeTruthy());
  expect(getChatDraft(draft.id)).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /New chat/ })),
  );
});
it('keeps the repository receipt and exposes retry when lifecycle cleanup fails', async () => {
  const draft = { ...createChatDraft(), text: 'Keep this repository task' };
  draft.settings.selection = { accountId: 'work', model: 'model-a' };
  draft.settings.repositoryWorkspaceId = '8ca30b0d-3e65-4eeb-8244-f6277350818f';
  saveChatDraft(draft);
  vi.mocked(apiFetch).mockRejectedValue(new Error('offline'));
  render(
    <MemoryRouter>
      <DraftsView />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm discard' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/preparation.*kept/i));
  expect(getChatDraft(draft.id)?.text).toBe(draft.text);
  expect(
    (screen.getByRole('button', { name: 'Confirm discard' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});
it('shows the saved prompt and its account, model and thinking level with an editable link', async () => {
  const draft = { ...createChatDraft(), text: 'Fix the morning briefing' };
  draft.settings.selection = { accountId: 'work', model: 'model-a', reasoningEffort: 'high' };
  draft.settings.summary = { profile: 'Work API', model: 'Model A', thinking: 'Thinking: high' };
  saveChatDraft(draft);
  render(
    <MemoryRouter>
      <DraftsView />
    </MemoryRouter>,
  );
  const link = screen.getByRole('link', { name: /Fix the morning briefing/ });
  expect(link.getAttribute('href')).toContain(`draft=${draft.id}`);
  expect(screen.getByText('Work API')).toBeTruthy();
  expect(screen.getByText('Model A')).toBeTruthy();
  expect(screen.getByText('Thinking: high')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm discard' }));
  expect(listChatDrafts()).toEqual([]);
  expect(screen.getByText('No drafts yet')).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /New chat/ })),
  );
});
it('preserves and shows the old shared new-chat draft instead of opening it as New chat', () => {
  localStorage.setItem('mitzo-draft-new', 'Existing unsent message');
  render(
    <MemoryRouter>
      <DraftsView />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: /Existing unsent message/ })).toBeTruthy();
  expect(screen.getByRole('link', { name: /New chat/ }).getAttribute('href')).toBe('/chat');
});

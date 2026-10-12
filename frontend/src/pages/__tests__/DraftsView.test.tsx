// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { DraftsView } from '../DraftsView';
import { createChatDraft, saveChatDraft, listChatDrafts } from '../../lib/chat-drafts';
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it('shows the saved prompt and its account, model and thinking level with an editable link', () => {
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

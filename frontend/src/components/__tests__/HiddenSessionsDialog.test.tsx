// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { HiddenSessionsDialog } from '../HiddenSessionsDialog';
import { readApiJson } from '../../lib/api-json-read';
import { apiFetch } from '../../lib/api-fetch';
import { newChatPathWithDraft } from '../../lib/chat-drafts';
import { useSessionList } from '../../hooks/useSessionList';
vi.mock('../../lib/api-json-read', () => ({ readApiJson: vi.fn() }));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  AUTH_LOST_EVENT: 'auth-lost',
  AUTH_RESTORED_EVENT: 'auth-restored',
}));
vi.mock('../../lib/chat-drafts', () => ({
  newChatPathWithDraft: vi.fn(() => '/chat?draft=continuation'),
}));
vi.mock('../../hooks/useSavedSessionMessages', () => ({
  useSavedSessionMessages: () => ({
    messages: [{ id: 'reply', role: 'assistant', text: 'The PR was merged.' }],
    error: false,
    retry: vi.fn(),
  }),
}));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  vi.mocked(readApiJson).mockResolvedValue({
    sessions: [{ id: 'c', summary: 'Finished chat', lastModified: 1, resourcesReleased: false }],
    hasMore: false,
  });
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ ok: true })));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('views retained history without restoring or starting a runtime', async () => {
  render(<HiddenSessionsDialog onClose={vi.fn()} onChanged={vi.fn()} onCleanup={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Finished chat' }));
  expect(await screen.findByText('The PR was merged.')).toBeTruthy();
  expect(apiFetch).not.toHaveBeenCalled();
});
it('restores a hidden chat and keeps restore failures visible and retryable', async () => {
  const changed = vi.fn();
  render(<HiddenSessionsDialog onClose={vi.fn()} onChanged={changed} onCleanup={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Finished chat' }));
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ error: 'Review recovery first.' }), { status: 409 }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Restore chat' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Review recovery first.');
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Restore chat' }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/sessions/c/visibility',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ hidden: false }) }),
  );
});
it('continues released work in an editable fresh draft with explicit workspace guidance and attributed history', async () => {
  vi.mocked(readApiJson).mockResolvedValue({
    sessions: [{ id: 'c', summary: 'Finished chat', lastModified: 1, resourcesReleased: true }],
    hasMore: false,
  });
  const continued = vi.fn();
  render(
    <HiddenSessionsDialog
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onCleanup={vi.fn()}
      onContinue={continued}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Finished chat' }));
  expect(screen.queryByRole('button', { name: 'Restore chat' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Continue in new chat' }));
  expect(newChatPathWithDraft).toHaveBeenCalledWith(
    expect.stringContaining('Prepare a fresh isolated workspace'),
  );
  expect(newChatPathWithDraft).toHaveBeenCalledWith(expect.stringContaining('The PR was merged.'));
  expect(continued).toHaveBeenCalledWith('/chat?draft=continuation');
  expect(apiFetch).not.toHaveBeenCalled();
});

it('clears the local hide marker on confirmed restore even outside the recent page', async () => {
  window.dispatchEvent(new Event('auth-lost'));
  let firstPage = [{ id: 'c', summary: 'Finished chat', lastModified: 1 }];
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    Response.json(url === '/api/sessions' ? { sessions: firstPage, hasMore: true } : { ok: true }),
  );
  const list = renderHook(() => useSessionList());
  await waitFor(() => expect(list.result.current.sessions).toHaveLength(1));
  await act(async () => {
    await list.result.current.hideSession('c');
  });
  expect(list.result.current.hiddenSessionIds.has('c')).toBe(true);
  firstPage = Array.from({ length: 20 }, (_, i) => ({
    id: `new-${i}`,
    summary: 'Newer',
    lastModified: i + 2,
  }));
  render(
    <HiddenSessionsDialog
      onClose={vi.fn()}
      onChanged={list.result.current.retry}
      onCleanup={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Finished chat' }));
  fireEvent.click(screen.getByRole('button', { name: 'Restore chat' }));
  await waitFor(() => expect(list.result.current.sessions).toHaveLength(20));
  expect(list.result.current.hiddenSessionIds.has('c')).toBe(false);
});

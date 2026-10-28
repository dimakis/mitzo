// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../api-fetch';
import { createChatDraft, getChatDraft, saveChatDraft } from '../chat-drafts';
import { discardChatDraft } from '../discard-chat-draft';
import { chatStorage } from '../large-chat-storage';

vi.mock('../api-fetch', () => ({ apiFetch: vi.fn() }));
const preparationId = '8ca30b0d-3e65-4eeb-8244-f6277350818f';
function preparedDraft() {
  const draft = { ...createChatDraft(), text: 'Repository task' };
  draft.settings.selection = { accountId: 'work', model: 'model-a' };
  draft.settings.repositoryWorkspaceId = preparationId;
  saveChatDraft(draft);
  return getChatDraft(draft.id)!;
}
beforeEach(() => {
  localStorage.clear();
  vi.mocked(apiFetch).mockReset();
});
afterEach(() => vi.restoreAllMocks());

it('discards ordinary drafts without making a backend call', async () => {
  const draft = { ...createChatDraft(), text: 'Local thought' };
  saveChatDraft(draft);
  await discardChatDraft(getChatDraft(draft.id)!);
  expect(getChatDraft(draft.id)).toBeNull();
  expect(apiFetch).not.toHaveBeenCalled();
});
it.each(['preview', 'ready', 'failed', 'discarded'])(
  'releases an exact unused preparation before deleting its %s draft',
  async (state) => {
    const draft = preparedDraft();
    vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
      expect(getChatDraft(draft.id)).not.toBeNull();
      return new Response(
        JSON.stringify(
          options?.method === 'DELETE' ? { discarded: true } : { id: preparationId, state },
        ),
      );
    });
    await discardChatDraft(draft);
    expect(apiFetch).toHaveBeenNthCalledWith(
      1,
      `/api/repository-workspaces/${preparationId}?accountId=work&model=model-a`,
    );
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      `/api/repository-workspaces/${preparationId}?accountId=work&model=model-a`,
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(getChatDraft(draft.id)).toBeNull();
  },
);
it.each(['preparing', 'claiming', 'claimed', 'unknown'])(
  'retains the exact receipt and never deletes a preparation in state %s',
  async (state) => {
    const draft = preparedDraft();
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ id: preparationId, state })),
    );
    await expect(discardChatDraft(draft)).rejects.toThrow(/preparation/);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(getChatDraft(draft.id)).toEqual(draft);
  },
);
it.each(['lookup', 'lookup-status', 'identity', 'delete', 'acknowledgement'])(
  'keeps the draft on uncertain or failed cleanup: %s',
  async (failure) => {
    const draft = preparedDraft();
    vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
      if (failure === 'lookup') throw new Error('offline');
      if (failure === 'lookup-status') return new Response('{}', { status: 404 });
      if (!options?.method)
        return new Response(
          JSON.stringify({
            id: failure === 'identity' ? 'aaaaaaaa-bbbb-4ccc-8ddd-121212121212' : preparationId,
            state: 'ready',
          }),
        );
      return new Response(JSON.stringify({ discarded: failure !== 'acknowledgement' }), {
        status: failure === 'delete' ? 409 : 200,
      });
    });
    await expect(discardChatDraft(draft)).rejects.toThrow();
    expect(getChatDraft(draft.id)).toEqual(draft);
  },
);
it('retains a preparation whose saved account binding is unavailable', async () => {
  const draft = preparedDraft();
  const unbound = { ...draft, settings: { ...draft.settings, selection: null } };
  saveChatDraft(unbound);
  const snapshot = getChatDraft(draft.id)!;
  await expect(discardChatDraft(snapshot)).rejects.toThrow(/account.*unavailable/);
  expect(apiFetch).not.toHaveBeenCalled();
  expect(getChatDraft(draft.id)).toEqual(snapshot);
});
it.each(['lookup', 'delete'])(
  'does not erase edits made in another tab during %s',
  async (phase) => {
    const draft = preparedDraft();
    vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
      const deleting = options?.method === 'DELETE';
      if (deleting === (phase === 'delete')) saveChatDraft({ ...draft, text: 'Newer edit' });
      return new Response(
        JSON.stringify(deleting ? { discarded: true } : { id: preparationId, state: 'ready' }),
      );
    });
    await expect(discardChatDraft(draft)).rejects.toThrow(/changed/);
    expect(getChatDraft(draft.id)?.text).toBe('Newer edit');
    expect(apiFetch).toHaveBeenCalledTimes(phase === 'lookup' ? 1 : 2);
  },
);
it('refuses an edited snapshot before making backend calls', async () => {
  const draft = preparedDraft();
  saveChatDraft({ ...draft, text: 'Edit before confirming' });
  await expect(discardChatDraft(draft)).rejects.toThrow(/changed/);
  expect(apiFetch).not.toHaveBeenCalled();
});

it('does not confirm discard until the durable deletion has committed', async () => {
  const draft = { ...createChatDraft(), text: 'Wait for the durable deletion' };
  saveChatDraft(draft);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const flush = vi.spyOn(chatStorage, 'flush').mockReturnValue(gate);
  const settled = vi.fn();
  const discard = discardChatDraft(getChatDraft(draft.id)!).then(settled);
  await Promise.resolve();
  expect(flush).toHaveBeenCalledTimes(1);
  expect(settled).not.toHaveBeenCalled();
  release();
  await discard;
  expect(settled).toHaveBeenCalledTimes(1);
});

it('does not report success when durable deletion fails', async () => {
  const draft = { ...createChatDraft(), text: 'Retain a failed discard outcome' };
  saveChatDraft(draft);
  vi.spyOn(chatStorage, 'flush').mockRejectedValue(Error('Database unavailable'));
  await expect(discardChatDraft(getChatDraft(draft.id)!)).rejects.toThrow();
});

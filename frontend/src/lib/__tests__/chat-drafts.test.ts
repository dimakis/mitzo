// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createChatDraft,
  saveChatDraft,
  getChatDraft,
  listChatDrafts,
  deleteChatDraft,
  consumeChatDraft,
  migrateLegacyChatDraft,
} from '../chat-drafts';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
describe('saved new-chat drafts', () => {
  it('retains a newer legacy message written by an older open tab after migration', () => {
    localStorage.setItem('mitzo-draft-new', 'First legacy message');
    migrateLegacyChatDraft();
    localStorage.setItem('mitzo-draft-new', 'Different second message');
    migrateLegacyChatDraft();
    expect(
      listChatDrafts()
        .map((draft) => draft.text)
        .sort(),
    ).toEqual(['Different second message', 'First legacy message']);
    expect(localStorage.getItem('mitzo-draft-new')).toBeNull();
  });
  it('creates independent blank composers without reopening a saved draft', () => {
    const first = createChatDraft();
    saveChatDraft({ ...first, text: 'Fix the morning briefing' });
    const second = createChatDraft();
    expect(second.id).not.toBe(first.id);
    expect(second.text).toBe('');
    expect(listChatDrafts().map((d) => d.id)).toEqual([first.id]);
  });
  it('restores editable content, attachments, context and all launch settings', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const draft = {
      ...createChatDraft(),
      text: 'Help with this screenshot',
      images: [{ data: 'abc', preview: 'data:image/png;base64,abc', mediaType: 'image/png' }],
      contextBlocks: ['Pinned context'],
      settings: {
        selection: { accountId: 'work', model: 'model-a', reasoningEffort: 'high' },
        mode: 'ask' as const,
        isolation: false,
        search: 'cwd=%2Fworkspace&extraTools=Files&agentProfile=profile&profileRevision=2',
        summary: { profile: 'Work API', model: 'Model A', thinking: 'Thinking: high' },
      },
    };
    now.mockReturnValue(1001);
    expect(saveChatDraft(draft)).toBe(true);
    expect(getChatDraft(draft.id)).toMatchObject({ ...draft, updatedAt: 1001 });
    now.mockReturnValue(2000);
    saveChatDraft({ ...draft, text: 'Edited message' });
    expect(getChatDraft(draft.id)).toMatchObject({ text: 'Edited message', updatedAt: 2000 });
  });
  it('consumes only the accepted revision and keeps newer edits', () => {
    const draft = { ...createChatDraft(), text: 'Original' };
    saveChatDraft(draft);
    saveChatDraft({ ...draft, text: 'Newer edit' });
    expect(consumeChatDraft(draft)).toBe(false);
    expect(getChatDraft(draft.id)?.text).toBe('Newer edit');
    expect(consumeChatDraft(getChatDraft(draft.id)!)).toBe(true);
    expect(listChatDrafts()).toEqual([]);
  });
  it('keeps separate drafts and removes empty or explicitly discarded drafts', () => {
    const first = { ...createChatDraft(), text: 'First' };
    const second = { ...createChatDraft(), text: 'Second' };
    saveChatDraft(first);
    saveChatDraft(second);
    deleteChatDraft(first.id);
    expect(listChatDrafts().map((d) => d.id)).toEqual([second.id]);
    saveChatDraft({ ...second, text: '' });
    expect(listChatDrafts()).toEqual([]);
  });
  it('migrates the existing shared draft once with saved account preferences', () => {
    localStorage.setItem('mitzo-draft-new', 'Existing unsent message');
    localStorage.setItem(
      'mitzo-default-account-model',
      JSON.stringify({ accountId: 'work', model: 'model-a', reasoningEffort: 'medium' }),
    );
    migrateLegacyChatDraft();
    migrateLegacyChatDraft();
    expect(listChatDrafts()).toHaveLength(1);
    expect(listChatDrafts()[0]).toMatchObject({
      text: 'Existing unsent message',
      settings: { selection: { accountId: 'work', model: 'model-a', reasoningEffort: 'medium' } },
    });
    expect(localStorage.getItem('mitzo-draft-new')).toBeNull();
  });
  it('ignores malformed saved data and reports failed saves without losing the legacy draft', () => {
    localStorage.setItem('mitzo-chat-draft:broken', '{bad');
    localStorage.setItem('mitzo-chat-draft:invalid', JSON.stringify({ text: 'Untrusted shape' }));
    expect(listChatDrafts()).toEqual([]);
    localStorage.setItem('mitzo-draft-new', 'Keep me');
    const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded');
    });
    expect(saveChatDraft({ ...createChatDraft(), text: 'Unpersisted' })).toBe(false);
    migrateLegacyChatDraft();
    expect(localStorage.getItem('mitzo-draft-new')).toBe('Keep me');
    fail.mockRestore();
  });
});
it('creates independent persistent draft identities on remote HTTP without randomUUID', () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  try {
    const first = createChatDraft();
    const second = createChatDraft();
    expect(first.id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(second.id).not.toBe(first.id);
    saveChatDraft({ ...first, text: 'Saved over HTTP' });
    expect(getChatDraft(first.id)?.id).toBe(first.id);
    expect(getChatDraft(first.id)?.text).toBe('Saved over HTTP');
  } finally {
    vi.unstubAllGlobals();
  }
});

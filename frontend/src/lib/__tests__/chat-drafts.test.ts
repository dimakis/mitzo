// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
describe('saved new-chat drafts', () => {
  it('creates independent blank composers without reopening a saved draft', () => {
    const first = createChatDraft();
    saveChatDraft({ ...first, text: 'Fix the morning briefing' });
    const second = createChatDraft();
    expect(second.id).not.toBe(first.id);
    expect(second.text).toBe('');
    expect(listChatDrafts().map((d) => d.id)).toEqual([first.id]);
  });
  it('restores editable content, attachments, context and all launch settings', () => {
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
    expect(saveChatDraft(draft)).toBe(true);
    expect(getChatDraft(draft.id)).toMatchObject(draft);
    saveChatDraft({ ...draft, text: 'Edited message' });
    expect(getChatDraft(draft.id)?.text).toBe('Edited message');
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

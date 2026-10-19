// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import type { CollaborationMessageInput } from '@mitzo/protocol';
import { createChatDraft, getChatDraft, saveChatDraft, consumeChatDraft } from '../chat-drafts';

afterEach(() => localStorage.clear());
const group = '00000000-0000-4000-8000-000000000001';
it.each<CollaborationMessageInput['responders']>([
  { kind: 'default' },
  { kind: 'all' },
  { kind: 'selected', sessionIds: [] },
  { kind: 'selected', sessionIds: ['original-session', 'unavailable-session'] },
])(
  'retains exact %j responder intent in the existing owner even for a blank draft',
  (responders) => {
    const draft = createChatDraft();
    draft.settings.collaborationResponders = { collaborationId: group, responders };
    expect(saveChatDraft(draft)).toBe(true);
    expect(getChatDraft(draft.id)?.settings.collaborationResponders).toEqual({
      collaborationId: group,
      responders,
    });
    expect(Object.keys(localStorage)).toEqual([`mitzo-chat-draft:${draft.id}`]);
  },
);
it('does not consume a submitted draft after its recipient intent changes', () => {
  const submitted = createChatDraft();
  submitted.text = 'Keep this prompt';
  submitted.settings.collaborationResponders = {
    collaborationId: group,
    responders: { kind: 'selected', sessionIds: ['one'] },
  };
  expect(saveChatDraft(submitted)).toBe(true);
  expect(
    saveChatDraft({
      ...submitted,
      settings: {
        ...submitted.settings,
        collaborationResponders: {
          collaborationId: group,
          responders: { kind: 'selected', sessionIds: [] },
        },
      },
    }),
  ).toBe(true);
  expect(consumeChatDraft(submitted)).toBe(false);
  expect(getChatDraft(submitted.id)?.settings.collaborationResponders?.responders).toEqual({
    kind: 'selected',
    sessionIds: [],
  });
});
it('leaves ordinary and legacy draft semantics unchanged', () => {
  const empty = createChatDraft();
  expect(saveChatDraft(empty)).toBe(true);
  expect(getChatDraft(empty.id)).toBeNull();
  const legacy = { ...createChatDraft(), text: 'Ordinary draft' };
  expect(saveChatDraft(legacy)).toBe(true);
  expect(getChatDraft(legacy.id)?.settings).not.toHaveProperty('collaborationResponders');
});

// @vitest-environment jsdom
import { cleanup, renderHook, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useNewChatDraft } from '../useNewChatDraft';
import { createChatDraft, saveChatDraft, getChatDraft } from '../../lib/chat-drafts';
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it('restores settings without clobbering the saved account during catalog loading', () => {
  const draft = { ...createChatDraft(), text: 'Task' };
  draft.settings.selection = { accountId: 'work', model: 'model-a', reasoningEffort: 'high' };
  draft.settings.isolation = false;
  draft.settings.mode = 'ask';
  saveChatDraft(draft);
  const { result } = renderHook(() => useNewChatDraft(draft.id, 0, true));
  expect(result.current.restored).toBe(true);
  expect(result.current.draft.settings).toMatchObject(draft.settings);
  act(() => result.current.saveSettings({ ...draft.settings, selection: null }));
  expect(getChatDraft(draft.id)?.settings.selection).toEqual(draft.settings.selection);
  act(() =>
    result.current.saveSettings({
      ...draft.settings,
      selection: { accountId: 'personal', model: 'model-b' },
    }),
  );
  expect(getChatDraft(draft.id)?.settings.selection?.accountId).toBe('personal');
});
it('creates a fresh identity for genuine New chat and preserves the previous draft', () => {
  const { result, rerender } = renderHook(
    ({ generation }) => useNewChatDraft(null, generation, true),
    { initialProps: { generation: 0 } },
  );
  const first = result.current.draft;
  saveChatDraft({ ...first, text: 'Saved thought' });
  rerender({ generation: 1 });
  expect(result.current.draft.id).not.toBe(first.id);
  expect(result.current.draft.text).toBe('');
  expect(getChatDraft(first.id)?.text).toBe('Saved thought');
});
it('blocks missing draft references instead of quietly substituting another draft', () => {
  const { result } = renderHook(() => useNewChatDraft('missing', 0, true));
  expect(result.current.missing).toBe(true);
});

it.each([true, false])(
  'keeps new and existing conversation ownership stable without randomUUID (draft enabled: %s)',
  (enabled) => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    try {
      const { result, rerender } = renderHook(
        ({ requestedId, generation }) => useNewChatDraft(requestedId, generation, enabled),
        { initialProps: { requestedId: null as string | null, generation: 0 } },
      );
      const first = result.current.draft;
      saveChatDraft({ ...first, text: 'HTTP draft' });
      rerender({ requestedId: first.id, generation: 0 });
      expect(result.current.draft.id).toBe(first.id);
      rerender({ requestedId: null, generation: 1 });
      expect(result.current.draft.id).not.toBe(first.id);
      expect(getChatDraft(first.id)?.text).toBe('HTTP draft');
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

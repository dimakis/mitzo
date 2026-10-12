// @vitest-environment jsdom
import { cleanup, renderHook, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useNewChatDraft, useChatDraftSearch } from '../useNewChatDraft';
import { Router, createPath, useNavigate, type Navigator } from 'react-router-dom';
import { StrictMode, type ReactNode } from 'react';
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

it('retains restored launch context until router location acknowledges hydration, then honors explicit removals and draft switches', () => {
  const first = { ...createChatDraft(), id: 'first-search', text: 'First draft' };
  first.settings.search = 'cwd=%2Fworkspace&extraTools=Files';
  const second = { ...createChatDraft(), id: 'second-search', text: 'Second draft' };
  second.settings.search = 'cwd=%2Fsecond&extraTools=Read';
  saveChatDraft(first);
  saveChatDraft(second);
  let location = '/chat?draft=first-search&prompt=Original';
  const replace = vi.fn<Navigator['replace']>();
  const navigator: Navigator = {
    createHref: (target) => (typeof target === 'string' ? target : createPath(target)),
    go: vi.fn<Navigator['go']>(),
    push: vi.fn<Navigator['push']>(),
    replace,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StrictMode>
      <Router location={location} navigator={navigator}>
        {children}
      </Router>
    </StrictMode>
  );
  const { result, rerender } = renderHook(() => useChatDraftSearch(true), { wrapper });
  expect(result.current.get('cwd')).toBe('/workspace');
  expect(replace).toHaveBeenCalledTimes(1);
  // Browser history has changed, but React Router's transition has not committed
  // its location yet. An unrelated urgent render must retain the effective view.
  rerender();
  expect(result.current.get('cwd')).toBe('/workspace');
  expect(result.current.get('extraTools')).toBe('Files');
  const cleared = new URLSearchParams(result.current);
  cleared.delete('draft');
  cleared.delete('prompt');
  expect(cleared.toString()).toBe('cwd=%2Fworkspace&extraTools=Files');
  location = '/chat?cwd=%2Fworkspace&extraTools=Files&draft=first-search&prompt=Original';
  rerender();
  // Once restored location is observed, removing context is an explicit edit.
  location = '/chat?draft=first-search&prompt=Original';
  rerender();
  expect(result.current.get('cwd')).toBeNull();
  expect(result.current.get('extraTools')).toBeNull();
  location = '/chat?draft=second-search';
  rerender();
  rerender();
  expect(result.current.get('cwd')).toBe('/second');
  expect(result.current.get('extraTools')).toBe('Read');
});

it('keeps an explicit query edit authoritative even before hydration location commits', () => {
  const draft = { ...createChatDraft(), id: 'pending-edit', text: 'Saved draft' };
  draft.settings.search = 'cwd=%2Fworkspace&extraTools=Files';
  saveChatDraft(draft);
  let location = '/chat?draft=pending-edit&prompt=Original';
  const replace = vi.fn<Navigator['replace']>();
  const navigator: Navigator = {
    createHref: (target) => (typeof target === 'string' ? target : createPath(target)),
    go: vi.fn(),
    push: vi.fn(),
    replace,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Router location={location} navigator={navigator}>
      {children}
    </Router>
  );
  const { result, rerender } = renderHook(() => useChatDraftSearch(true), { wrapper });
  location = '/chat?draft=pending-edit&prompt=Explicit';
  rerender();
  expect(result.current.get('cwd')).toBeNull();
  location = '/chat?draft=pending-edit&prompt=Original';
  rerender();
  expect(result.current.get('cwd')).toBeNull();
  expect(replace).toHaveBeenCalledTimes(1);
});

it('clears a pending restored draft into a reloadable context URL without another hydration request', () => {
  const draft = { ...createChatDraft(), id: 'pending-clear', text: 'Saved draft' };
  draft.settings.search = 'cwd=%2Fworkspace&extraTools=Files';
  saveChatDraft(draft);
  let location = '/chat?draft=pending-clear&prompt=Original';
  const replace = vi.fn<Navigator['replace']>();
  const navigator: Navigator = {
    createHref: (target) => (typeof target === 'string' ? target : createPath(target)),
    go: vi.fn(),
    push: vi.fn(),
    replace,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Router location={location} navigator={navigator}>
      {children}
    </Router>
  );
  const { result, rerender } = renderHook(
    () => ({ search: useChatDraftSearch(true), navigate: useNavigate() }),
    { wrapper },
  );
  rerender();
  const cleared = new URLSearchParams(result.current.search);
  cleared.delete('draft');
  cleared.delete('prompt');
  act(() => result.current.navigate(`/chat?${cleared}`, { replace: true }));
  expect(replace).toHaveBeenLastCalledWith(
    expect.objectContaining({ pathname: '/chat', search: '?cwd=%2Fworkspace&extraTools=Files' }),
    undefined,
    { replace: true },
  );
  location = `/chat?${cleared}`;
  rerender();
  rerender();
  expect(result.current.search.get('draft')).toBeNull();
  expect(result.current.search.get('prompt')).toBeNull();
  expect(result.current.search.get('cwd')).toBe('/workspace');
  expect(replace).toHaveBeenCalledTimes(2);
});

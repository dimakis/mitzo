// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../../lib/api-fetch';
import { useKnowledgeLibrary } from '../useKnowledgeLibrary';
import type { KnowledgeDraft } from '../../types/knowledge';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn(), getApiBaseUrl: () => '' }));
const document = { path: 'hub/principles.md', title: 'Principles', area: 'Hub' };
const item = { path: document.path, base: 'original', content: 'original' };
const draft: KnowledgeDraft = {
  id: 'd1',
  title: 'Principles',
  version: 1,
  baseRevision: 'r1',
  state: 'draft',
  documents: [item],
  updatedAt: '2026-10-09T10:00:00Z',
};
const catalog = {
  revision: 'r1',
  documents: [document],
  drafts: [],
  reviewEnabled: false,
  acceptanceEnabled: false,
  syncedAt: null,
};
const response = (data: unknown) => ({ ok: true, json: async () => data }) as Response;
beforeEach(() => {
  localStorage.clear();
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/knowledge') return response(catalog);
    if (path.startsWith('/api/knowledge/document')) return response({ content: 'original' });
    if (init?.method === 'PUT')
      return response({
        draft: { ...draft, version: 2, documents: [{ ...item, content: 'edited' }] },
      });
    return response({ draft });
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
async function setup() {
  const rendered = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(rendered.result.current.catalog).toBeTruthy());
  return rendered;
}
it('advances the history reset epoch when reloading the same accepted document', async () => {
  const { result } = await setup();
  await act(() => result.current.openDocument(document));
  const initial = result.current.historyResetKey;
  act(() => result.current.change('edited'));
  expect(result.current.historyResetKey).toBe(initial);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await act(() => result.current.openDocument(document));
  expect(result.current.historyResetKey).toBeGreaterThan(initial);
  expect(result.current.canUndo).toBe(false);
});
it('advances the epoch when reopening a draft with the same path and text', async () => {
  const { result } = await setup();
  await act(() => result.current.openDraft(draft));
  const initial = result.current.historyResetKey;
  act(() => result.current.change('edited'));
  act(() => result.current.undo());
  await act(() => result.current.openDraft(draft));
  expect(result.current.selected?.content).toBe('original');
  expect(result.current.historyResetKey).toBeGreaterThan(initial);
  expect(result.current.canRedo).toBe(false);
});
it('advances the epoch when matching saved conflict content is adopted', async () => {
  localStorage.setItem(
    'mitzo-knowledge-working-copy:',
    JSON.stringify({
      title: 'Principles',
      baseRevision: 'r1',
      documents: [item],
      selected: item.path,
      saved: JSON.stringify([item]),
      initialSaveConflict: { ...draft, version: 2, documents: [{ ...item, content: 'edited' }] },
    }),
  );
  const { result } = await setup();
  act(() => result.current.change('edited'));
  const initial = result.current.historyResetKey;
  await act(() => result.current.resolveInitialSaveConflict(false));
  expect(result.current.selected?.content).toBe('edited');
  expect(result.current.historyResetKey).toBeGreaterThan(initial);
  expect(result.current.canUndo).toBe(false);
});
it('keeps the epoch stable for edits, undo, redo and ordinary saves', async () => {
  const { result } = await setup();
  await act(() => result.current.openDraft(draft));
  const initial = result.current.historyResetKey;
  act(() => result.current.change('edited'));
  act(() => result.current.undo());
  act(() => result.current.redo());
  await act(() => result.current.save());
  expect(result.current.selected?.content).toBe('edited');
  expect(result.current.historyResetKey).toBe(initial);
  expect(result.current.canUndo).toBe(true);
});

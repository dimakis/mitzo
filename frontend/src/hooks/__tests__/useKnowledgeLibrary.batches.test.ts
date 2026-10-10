// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useKnowledgeLibrary } from '../useKnowledgeLibrary';
const fetch = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api-fetch', () => ({ apiFetch: fetch, getApiBaseUrl: () => '' }));
const key = 'mitzo-knowledge-working-copy:';
const document = { path: 'hub/a.md', title: 'A', area: 'Hub' };
const item = { path: document.path, base: 'accepted', content: 'saved edit' };
const draft = {
  id: 'batch',
  title: 'Batch',
  baseRevision: 'base',
  version: 2,
  state: 'draft',
  documents: [item],
  directories: ['hub/empty'],
  updatedAt: '',
};
const catalog = {
  revision: 'base',
  documents: [document, { ...document, path: 'hub/b.md', title: 'B' }],
  directories: ['hub'],
  documentPaths: ['hub'],
  drafts: [],
  reviewEnabled: true,
};
function recover(saved = draft) {
  localStorage.setItem(
    key,
    JSON.stringify({
      title: saved.title,
      baseRevision: saved.baseRevision,
      draft: saved,
      documents: saved.documents,
      directories: saved.directories,
      savedDirectories: saved.directories,
      selected: item.path,
      saved: JSON.stringify(saved.documents),
    }),
  );
}
beforeEach(() => {
  localStorage.clear();
  fetch.mockReset().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => (url === '/api/knowledge' ? catalog : { content: 'accepted' }),
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('saves a new batch durably without any review request and makes clean saves no-ops', async () => {
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  await act(async () => {
    await result.current.openDocument(document);
  });
  act(() => result.current.change('edited'));
  fetch.mockClear().mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return {
      ok: true,
      json: async () => ({
        draft: {
          ...draft,
          id: body.requestId,
          version: 1,
          documents: body.documents.map((d: object) => ({ ...d, base: 'accepted' })),
          directories: body.directories,
        },
      }),
    };
  });
  await act(async () => {
    await result.current.save();
  });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/knowledge/drafts']);
  expect(result.current.dirty).toBe(false);
  expect(result.current.canSave).toBe(false);
  expect(result.current.canSendForReview).toBe(true);
  fetch.mockClear();
  await act(async () => {
    await result.current.save();
  });
  expect(fetch).not.toHaveBeenCalled();
});
it('collects another edited file into the saved batch while preserving prior text and folders', async () => {
  recover();
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  await act(async () => {
    expect(await result.current.openDocument(catalog.documents[1], true)).toBe(true);
  });
  act(() => result.current.change('second edit'));
  expect(result.current.copy?.documents).toEqual([
    item,
    { path: 'hub/b.md', base: 'accepted', content: 'second edit' },
  ]);
  expect(result.current.pendingDirectories).toEqual(['hub/empty']);
  expect(result.current.copy?.draft?.id).toBe('batch');
  expect(result.current.canSendForReview).toBe(false);
});
it.each(['accepted', 'closed'])(
  'rejects appending files to a %s draft without replacing its receipts',
  async (state) => {
    recover({ ...draft, state });
    const { result } = renderHook(useKnowledgeLibrary);
    await waitFor(() => expect(result.current.catalog).toBeTruthy());
    const before = localStorage.getItem(key);
    fetch.mockClear();
    await act(async () => {
      expect(await result.current.openDocument(catalog.documents[1], true)).toBe(false);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(before);
    expect(result.current.error).toContain('Start a new change');
  },
);
it('sends a clean saved batch with only its version and adopts the latest exact ready receipt', async () => {
  recover({
    ...draft,
    review: { url: 'https://github.com/example/k/pull/1', head: 'old', version: 1, ready: true },
  } as typeof draft);
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  expect(result.current.canSendForReview).toBe(true);
  fetch.mockClear().mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      draft: {
        ...draft,
        state: 'in-review',
        review: {
          url: 'https://github.com/example/k/pull/1',
          head: 'new',
          version: 2,
          ready: true,
        },
      },
    }),
  });
  await act(async () => {
    await result.current.sendForReview();
  });
  expect(fetch.mock.calls).toHaveLength(1);
  expect(fetch.mock.calls[0][0]).toBe('/api/knowledge/drafts/batch/ready');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ version: 2 });
  expect(result.current.copy?.draft?.review).toMatchObject({
    head: 'new',
    version: 2,
    ready: true,
  });
  expect(result.current.canSendForReview).toBe(false);
});
it('freezes edits during sending and retries a lost response with the same saved version', async () => {
  recover();
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  let reject!: (error: Error) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise((_done, fail) => {
        reject = fail;
      }),
  );
  let sending!: Promise<void>;
  act(() => {
    sending = result.current.sendForReview();
  });
  act(() => result.current.change('must not overwrite saved batch during send'));
  expect(result.current.selected?.content).toBe(item.content);
  await act(async () => {
    reject(new Error('lost acknowledgement'));
    await sending;
  });
  expect(result.current.copy?.draft).toEqual(draft);
  expect(result.current.canSendForReview).toBe(true);
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      draft: {
        ...draft,
        state: 'in-review',
        review: {
          url: 'https://github.com/example/k/pull/1',
          head: 'new',
          version: 2,
          ready: true,
        },
      },
    }),
  });
  await act(async () => {
    await result.current.sendForReview();
  });
  expect(
    fetch.mock.calls
      .filter(([url]) => url.endsWith('/ready'))
      .map(([, init]) => JSON.parse(init.body)),
  ).toEqual([{ version: 2 }, { version: 2 }]);
});
it('keeps accepted-source conflicts out of saved-draft comparison and rebases the existing batch', async () => {
  recover();
  let saved = { ...draft };
  fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/knowledge') return { ok: true, json: async () => catalog };
    if (url.endsWith('/ready')) {
      if (saved.baseRevision === 'base')
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: 'Accepted knowledge changed. Compare the accepted document.',
          }),
        };
      return {
        ok: true,
        json: async () => ({
          draft: {
            ...saved,
            state: 'in-review',
            review: {
              url: 'https://github.com/example/k/pull/1',
              head: 'rebased',
              version: saved.version,
              ready: true,
            },
          },
        }),
      };
    }
    if (url === '/api/knowledge/refresh')
      return { ok: true, json: async () => ({ ...catalog, revision: 'newer' }) };
    if (url.startsWith('/api/knowledge/document?'))
      return { ok: true, json: async () => ({ content: 'new accepted' }) };
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      saved = {
        ...saved,
        baseRevision: body.baseRevision,
        version: saved.version + 1,
        documents: body.documents.map((d: typeof item) => ({ ...d, base: 'new accepted' })),
      };
    }
    return { ok: true, json: async () => ({ draft: saved }) };
  });
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  await act(async () => {
    await result.current.sendForReview();
  });
  expect(result.current.copy?.initialSaveConflict).toBeUndefined();
  expect(result.current.error).toContain('Accepted knowledge changed');
  expect(result.current.copy?.draft?.id).toBe('batch');
  expect(result.current.selected?.content).toBe('saved edit');
  await act(async () => {
    await result.current.compare();
  });
  expect(result.current.comparison?.revision).toBe('newer');
  expect(result.current.comparison?.documents[0].content).toBe('new accepted');
  await act(async () => {
    await result.current.save('newer', [{ ...item, content: 'reconciled edit' }]);
  });
  expect(result.current.copy?.draft?.id).toBe('batch');
  expect(result.current.copy?.draft?.version).toBe(3);
  await act(async () => {
    await result.current.sendForReview();
  });
  expect(result.current.copy?.draft?.review?.ready).toBe(true);
});
it('preserves a saved batch on send conflict and loads the comparison without adopting remote edits', async () => {
  recover();
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  fetch.mockResolvedValueOnce({
    ok: false,
    status: 409,
    json: async () => ({ error: 'changed elsewhere' }),
  });
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      draft: { ...draft, version: 3, documents: [{ ...item, content: 'remote' }] },
    }),
  });
  await act(async () => {
    await result.current.sendForReview();
  });
  expect(result.current.selected?.content).toBe(item.content);
  expect(result.current.copy?.initialSaveConflict?.version).toBe(3);
  expect(result.current.canSendForReview).toBe(false);
});
it('saves newer edits without touching an already-ready review and makes its old receipt stale', async () => {
  const review = {
    url: 'https://github.com/example/k/pull/1',
    head: 'published',
    version: 2,
    ready: true,
  };
  recover({ ...draft, review } as typeof draft);
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  expect(result.current.canSendForReview).toBe(false);
  act(() => result.current.change('newer local edit'));
  fetch.mockClear().mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      draft: {
        ...draft,
        version: 3,
        documents: [{ ...item, content: 'newer local edit' }],
        review,
      },
    }),
  });
  await act(async () => {
    await result.current.save();
  });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/knowledge/drafts/batch']);
  expect(fetch.mock.calls[0][1].method).toBe('PUT');
  expect(result.current.copy?.draft?.review).toEqual(review);
  expect(result.current.copy?.draft?.version).toBe(3);
  expect(result.current.canSendForReview).toBe(true);
  expect(result.current.notice).toBe('Draft saved');
  fetch.mockClear();
  await act(async () => {
    await result.current.save();
    await result.current.accept();
  });
  expect(fetch).not.toHaveBeenCalled();
});
it('retains late authoring changes when a saved batch submission is acknowledged', async () => {
  recover();
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  let resolve!: (response: unknown) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let sending!: Promise<void>;
  act(() => {
    sending = result.current.sendForReview();
  });
  // A caller retaining the exposed authoring reference can update it after the request began.
  result.current.copy!.documents[0].content = 'late authoring text';
  result.current.copy!.directories.push('hub/late-folder');
  await act(async () => {
    resolve({
      ok: true,
      json: async () => ({
        draft: {
          ...draft,
          state: 'in-review',
          review: {
            url: 'https://github.com/example/k/pull/1',
            head: 'sent',
            version: 2,
            ready: true,
          },
        },
      }),
    });
    await sending;
  });
  expect(result.current.selected?.content).toBe('late authoring text');
  expect(result.current.pendingDirectories).toEqual(['hub/empty', 'hub/late-folder']);
  expect(result.current.dirty).toBe(true);
  expect(result.current.copy?.draft?.review?.head).toBe('sent');
  expect(result.current.canSendForReview).toBe(false);
});
it('retains late authoring references and intent when slow sending returns a conflict', async () => {
  recover();
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  let resolve!: (response: unknown) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ draft: { ...draft, version: 3 } }),
  });
  let sending!: Promise<void>;
  act(() => {
    sending = result.current.sendForReview();
  });
  result.current.copy!.documents[0].content = 'late text during conflict';
  result.current.copy!.directories.push('hub/late-conflict-folder');
  await act(async () => {
    resolve({ ok: false, status: 409, json: async () => ({ error: 'changed elsewhere' }) });
    await sending;
  });
  expect(result.current.selected?.content).toBe('late text during conflict');
  expect(result.current.pendingDirectories).toEqual(['hub/empty', 'hub/late-conflict-folder']);
  expect(result.current.copy?.initialSaveConflict?.version).toBe(3);
  expect(result.current.dirty).toBe(true);
});
it('blocks sending while accepted comparison contains an unresolved removed source', async () => {
  recover();
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  expect(result.current.canSendForReview).toBe(true);
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ ...catalog, revision: 'newer', documents: [] }),
  });
  await act(async () => {
    await result.current.compare();
  });
  expect(result.current.comparison?.documents[0].content).toBeNull();
  expect(result.current.canSendForReview).toBe(false);
  fetch.mockClear();
  await act(async () => {
    await result.current.sendForReview();
  });
  expect(fetch).not.toHaveBeenCalled();
});

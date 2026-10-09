// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useKnowledgeLibrary } from '../useKnowledgeLibrary';
const fetch = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api-fetch', () => ({ apiFetch: fetch, getApiBaseUrl: () => '' }));
const catalog = {
  revision: 'base',
  documents: [{ path: 'knowledge/a.md', title: 'A', area: 'knowledge' }],
  directories: ['knowledge'],
  drafts: [],
  reviewEnabled: false,
};
const key = 'mitzo-knowledge-working-copy:';
beforeEach(() => {
  localStorage.clear();
  fetch.mockReset().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => (url === '/api/knowledge' ? catalog : { content: 'original' }),
  }));
});
afterEach(cleanup);
it('reads without authoring, preserves edits through repeated moves and cancels a move back', async () => {
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  await act(async () => {
    await result.current.readDocument(catalog.documents[0]);
  });
  expect(localStorage.getItem(key)).toBeNull();
  await act(async () => {
    await result.current.openDocument(catalog.documents[0]);
  });
  act(() => result.current.change('edited'));
  act(() => result.current.moveDocument('knowledge/a.md', 'knowledge/folder/a.md'));
  expect(result.current.selected).toMatchObject({
    path: 'knowledge/folder/a.md',
    sourcePath: 'knowledge/a.md',
    content: 'edited',
  });
  act(() => result.current.moveDocument('knowledge/folder/a.md', 'knowledge/a.md'));
  expect(result.current.selected?.sourcePath).toBeUndefined();
  expect(result.current.selected?.content).toBe('edited');
});
it('recovers directory-only changes and keeps exact uncertain creation requests through later moves', async () => {
  const first = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(first.result.current.catalog).toBeTruthy());
  act(() => first.result.current.createDirectory('knowledge/empty'));
  expect(first.result.current.canSave).toBe(true);
  first.unmount();
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  expect(result.current.pendingDirectories).toEqual(['knowledge/empty']);
  fetch.mockImplementation(async (url: string) => {
    if (url === '/api/knowledge/drafts') throw new Error('lost response');
    return { ok: true, json: async () => ({ content: 'original' }) };
  });
  await act(async () => {
    await result.current.save();
  });
  const original = JSON.parse(
    fetch.mock.calls.find(([url]) => url === '/api/knowledge/drafts')![1].body,
  );
  expect(original).toMatchObject({ documents: [], directories: ['knowledge/empty'] });
  act(() => result.current.createDirectory('knowledge/second'));
  await act(async () => {
    await result.current.save();
  });
  const retries = fetch.mock.calls.filter(([url]) => url === '/api/knowledge/drafts');
  expect(JSON.parse(retries[1][1].body)).toEqual(original);
});
it('includes original source paths in a saved moved draft and recovers them', async () => {
  const { result, unmount } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  await act(async () => {
    await result.current.openDocument(catalog.documents[0]);
  });
  act(() => result.current.moveDocument('knowledge/a.md', 'knowledge/new/a.md'));
  fetch.mockRejectedValueOnce(new Error('lost'));
  await act(async () => {
    await result.current.save();
  });
  expect(JSON.parse(fetch.mock.calls.at(-1)![1].body).documents[0]).toMatchObject({
    sourcePath: 'knowledge/a.md',
    path: 'knowledge/new/a.md',
  });
  unmount();
  const recovered = renderHook(useKnowledgeLibrary);
  expect(recovered.result.current.selected?.sourcePath).toBe('knowledge/a.md');
});
it('adopts an acknowledged retry then saves later moves and folders with its version fence', async () => {
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  await act(async () => {
    await result.current.openDocument(catalog.documents[0]);
  });
  act(() => result.current.moveDocument('knowledge/a.md', 'knowledge/first/a.md'));
  fetch.mockRejectedValueOnce(new Error('lost response'));
  await act(async () => {
    await result.current.save();
  });
  const creation = JSON.parse(fetch.mock.calls.at(-1)![1].body);
  act(() => result.current.moveDocument('knowledge/first/a.md', 'knowledge/second/a.md'));
  act(() => result.current.createDirectory('knowledge/empty'));
  const draft = {
    id: 'draft',
    title: 'A',
    version: 1,
    baseRevision: 'base',
    state: 'draft' as const,
    documents: creation.documents.map((d: object) => ({ ...d, base: 'original' })),
    directories: [],
    updatedAt: '',
  };
  fetch.mockImplementation(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return {
      ok: true,
      json: async () => ({
        draft:
          url === '/api/knowledge/drafts'
            ? draft
            : {
                ...draft,
                version: 2,
                documents: body.documents.map((d: object) => ({ ...d, base: 'original' })),
                directories: body.directories,
              },
      }),
    };
  });
  await act(async () => {
    await result.current.save();
  });
  const put = fetch.mock.calls.find(
    ([url, init]) => url === '/api/knowledge/drafts/draft' && init.method === 'PUT',
  );
  expect(JSON.parse(put![1].body)).toMatchObject({
    version: 1,
    documents: [
      { path: 'knowledge/second/a.md', sourcePath: 'knowledge/a.md', content: 'original' },
    ],
    directories: ['knowledge/empty'],
  });
  expect(result.current.dirty).toBe(false);
  expect(result.current.selected?.path).toBe('knowledge/second/a.md');
});
it('opens saved directory-only drafts and defaults older recovered copies to no folders', async () => {
  localStorage.setItem(
    key,
    JSON.stringify({
      title: 'Old',
      baseRevision: 'base',
      documents: [{ path: 'knowledge/a.md', base: 'original', content: 'edited' }],
      selected: 'knowledge/a.md',
      saved: '[]',
    }),
  );
  const { result } = renderHook(useKnowledgeLibrary);
  expect(result.current.pendingDirectories).toEqual([]);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const draft = {
    id: 'folders',
    title: 'Folders',
    baseRevision: 'base',
    version: 1,
    documents: [],
    directories: ['knowledge/empty'],
    state: 'draft' as const,
    updatedAt: '',
  };
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ draft }) });
  await act(async () => {
    await result.current.openDraft(draft);
  });
  expect(result.current.copy?.draft?.id).toBe('folders');
  expect(result.current.pendingDirectories).toEqual(['knowledge/empty']);
  expect(result.current.dirty).toBe(false);
});
it('rejects moves between enrolled spokes and independently enrolled guidance paths', async () => {
  fetch.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url === '/api/knowledge'
        ? {
            ...catalog,
            documentPaths: ['knowledge/first', 'knowledge/second', 'AGENTS.md'],
            documents: [{ path: 'knowledge/first/a.md', title: 'A' }],
          }
        : { content: 'original' },
  }));
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  await act(async () => {
    await result.current.openDocument({
      path: 'knowledge/first/a.md',
      title: 'A',
      area: 'knowledge',
    });
  });
  act(() => {
    expect(result.current.moveDocument('knowledge/first/a.md', 'knowledge/second/a.md')).toBe(
      false,
    );
  });
  expect(result.current.selected?.path).toBe('knowledge/first/a.md');
  act(() => {
    expect(result.current.createDirectory('knowledge/third/empty')).toBe(false);
  });
  expect(result.current.pendingDirectories).toEqual([]);
  expect(result.current.canMoveDocument('AGENTS.md', 'knowledge/first/AGENTS.md')).toBe(false);
});
it('preserves moves and folders when a saved version conflicts, then resolves using the remote fence', async () => {
  const document = { path: 'knowledge/a.md', base: 'original', content: 'original' };
  const draft = {
    id: 'draft',
    title: 'A',
    baseRevision: 'base',
    version: 1,
    state: 'draft' as const,
    documents: [document],
    directories: [],
    updatedAt: '',
  };
  localStorage.setItem(
    key,
    JSON.stringify({
      title: 'A',
      baseRevision: 'base',
      draft,
      documents: [document],
      directories: [],
      selected: document.path,
      saved: JSON.stringify([document]),
    }),
  );
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  act(() => result.current.change('edited'));
  act(() => result.current.moveDocument(document.path, 'knowledge/new/a.md'));
  act(() => result.current.createDirectory('knowledge/empty'));
  const remote = { ...draft, version: 2 };
  fetch.mockImplementation(async (url: string, init: RequestInit) =>
    init.method === 'PUT'
      ? { ok: false, status: 409, json: async () => ({ error: 'changed elsewhere' }) }
      : { ok: true, json: async () => ({ draft: remote }) },
  );
  await act(async () => {
    await result.current.save();
  });
  expect(result.current.selected).toMatchObject({
    sourcePath: document.path,
    path: 'knowledge/new/a.md',
    content: 'edited',
  });
  expect(result.current.pendingDirectories).toEqual(['knowledge/empty']);
  expect(result.current.copy?.initialSaveConflict?.version).toBe(2);
  fetch.mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      version: 2,
      documents: [{ sourcePath: document.path, path: 'knowledge/new/a.md', content: 'edited' }],
      directories: ['knowledge/empty'],
    });
    return {
      ok: true,
      json: async () => ({
        draft: {
          ...remote,
          version: 3,
          documents: body.documents.map((d: object) => ({ ...d, base: 'original' })),
          directories: body.directories,
        },
      }),
    };
  });
  await act(async () => {
    await result.current.resolveInitialSaveConflict(false);
  });
  expect(result.current.copy?.draft?.version).toBe(3);
  expect(result.current.dirty).toBe(false);
});
it('keeps moves inside the original private boundary within a broad scope', async () => {
  fetch.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url === '/api/knowledge'
        ? {
            ...catalog,
            documentPaths: ['okrs'],
            documents: [{ path: 'okrs/private_eng_excellence/a.md', title: 'A' }],
          }
        : { content: 'original' },
  }));
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  await act(async () => {
    await result.current.openDocument({
      path: 'okrs/private_eng_excellence/a.md',
      title: 'A',
      area: 'okrs',
    });
  });
  expect(
    result.current.canMoveDocument(
      'okrs/private_eng_excellence/a.md',
      'okrs/shared_eng_excellence/a.md',
    ),
  ).toBe(false);
  expect(
    result.current.canMoveDocument('okrs/private_eng_excellence/a.md', 'okrs/private_other/a.md'),
  ).toBe(false);
  expect(
    result.current.canMoveDocument(
      'okrs/private_eng_excellence/a.md',
      'okrs/private_eng_excellence/folder/a.md',
    ),
  ).toBe(true);
});
it('reads and reopens a staged move destination without fetching it or replacing its edits', async () => {
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  await act(async () => {
    await result.current.openDocument(catalog.documents[0]);
  });
  act(() => result.current.change('edited'));
  act(() => result.current.moveDocument('knowledge/a.md', 'knowledge/new/a.md'));
  fetch.mockClear();
  const before = localStorage.getItem(key);
  await act(async () => {
    expect(
      await result.current.readDocument({
        path: 'knowledge/new/a.md',
        title: 'A',
        area: 'knowledge',
      }),
    ).toEqual({ content: 'edited' });
  });
  expect(localStorage.getItem(key)).toBe(before);
  await act(async () => {
    await result.current.openDocument({
      path: 'knowledge/new/a.md',
      title: 'A',
      area: 'knowledge',
    });
  });
  expect(result.current.selected?.content).toBe('edited');
  expect(fetch).not.toHaveBeenCalled();
});
it('continues an accepted move from its proven accepted destination while retaining later edits and folders', async () => {
  const moved = {
    path: 'knowledge/moved/a.md',
    sourcePath: 'knowledge/a.md',
    base: 'original',
    content: 'accepted text',
  };
  const local = { ...moved, path: 'knowledge/further/a.md', content: 'later edit' };
  const draft = {
    id: 'accepted',
    title: 'A',
    baseRevision: 'base',
    version: 1,
    state: 'accepted',
    documents: [moved],
    directories: ['knowledge/accepted-folder'],
    updatedAt: '',
  };
  localStorage.setItem(
    key,
    JSON.stringify({
      title: 'A',
      baseRevision: 'base',
      draft,
      documents: [local],
      directories: ['knowledge/accepted-folder', 'knowledge/new-folder'],
      savedDirectories: draft.directories,
      selected: local.path,
      saved: JSON.stringify([moved]),
    }),
  );
  fetch.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes('/document?')
        ? { content: 'accepted text' }
        : {
            ...catalog,
            revision: 'latest',
            documents: [{ path: moved.path, title: 'A' }],
            directories: ['knowledge', 'knowledge/accepted-folder'],
          },
  }));
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  await act(async () => {
    await result.current.startNewChangeWithEdits();
  });
  expect(result.current.selected).toMatchObject({
    path: local.path,
    sourcePath: moved.path,
    content: 'later edit',
    base: 'accepted text',
  });
  expect(result.current.pendingDirectories).toEqual(['knowledge/new-folder']);
  expect(result.current.comparison?.documents[0].content).toBe('accepted text');
});
it('does not normalize an accepted move when its destination content no longer matches its receipt', async () => {
  const moved = {
    path: 'knowledge/moved/a.md',
    sourcePath: 'knowledge/a.md',
    base: 'original',
    content: 'accepted text',
  };
  const draft = {
    id: 'accepted',
    title: 'A',
    baseRevision: 'base',
    version: 1,
    state: 'accepted',
    documents: [moved],
    updatedAt: '',
  };
  localStorage.setItem(
    key,
    JSON.stringify({
      title: 'A',
      baseRevision: 'base',
      draft,
      documents: [{ ...moved, content: 'later edit' }],
      directories: [],
      selected: moved.path,
      saved: JSON.stringify([moved]),
    }),
  );
  fetch.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes('/document?')
        ? { content: 'different accepted text' }
        : { ...catalog, revision: 'latest', documents: [{ path: moved.path, title: 'A' }] },
  }));
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  await act(async () => {
    await result.current.startNewChangeWithEdits();
  });
  expect(result.current.selected?.sourcePath).toBe('knowledge/a.md');
  expect(result.current.selected?.content).toBe('later edit');
  expect(result.current.comparison?.documents[0].content).toBeNull();
});
it('allows cancelling a pending folder after a collision blocks save', async () => {
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  act(() => result.current.createDirectory('knowledge/empty'));
  await act(async () => {
    await result.current.removeDirectory('knowledge/empty');
  });
  expect(result.current.pendingDirectories).toEqual([]);
  expect(result.current.canSave).toBe(false);
  expect(result.current.dirty).toBe(false);
});
it('settles an uncertain creation by replaying its exact request instead of treating an early 404 as completion', async () => {
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  act(() => result.current.createDirectory('knowledge/empty'));
  fetch.mockRejectedValueOnce(new Error('lost response while original POST continues'));
  await act(async () => {
    await result.current.save();
  });
  const original = result.current.copy!.pendingCreate!;
  const saved = {
    id: original.requestId,
    title: original.title,
    baseRevision: original.baseRevision,
    version: 1,
    state: 'draft',
    documents: [],
    directories: original.directories,
    updatedAt: '',
  };
  let settle!: (value: unknown) => void;
  fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (init.method === 'GET')
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: 'original POST not yet stored' }),
      };
    if (url === '/api/knowledge/drafts')
      return new Promise((done) => {
        settle = done;
      });
    return { ok: true, json: async () => ({ draft: { ...saved, state: 'closed' } }) };
  });
  let cancellation!: Promise<boolean>;
  act(() => {
    cancellation = result.current.removeDirectory('knowledge/empty');
  });
  expect(result.current.copy?.pendingCreate).toEqual(original);
  expect(result.current.pendingDirectories).toEqual(['knowledge/empty']);
  expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/knowledge/drafts');
  expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toEqual(original);
  await act(async () => {
    settle({ ok: true, json: async () => ({ draft: saved }) });
    expect(await cancellation).toBe(true);
  });
  expect(
    fetch.mock.calls.some(
      ([url, init]) => url.startsWith('/api/knowledge/drafts/') && init.method === 'GET',
    ),
  ).toBe(false);
  expect(fetch.mock.calls.at(-1)?.[0]).toBe(`/api/knowledge/drafts/${original.requestId}/cancel`);
  expect(result.current.copy?.draft?.state).toBe('closed');
  expect(result.current.copy?.pendingCreate).toBeUndefined();
  expect(result.current.pendingDirectories).toEqual([]);
});
it('preserves a frozen uncertain request when cancellation cannot prove it absent', async () => {
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  act(() => result.current.createDirectory('knowledge/empty'));
  fetch.mockRejectedValueOnce(new Error('lost response'));
  await act(async () => {
    await result.current.save();
  });
  const original = result.current.copy?.pendingCreate;
  fetch.mockRejectedValueOnce(new Error('offline'));
  await act(async () => {
    expect(await result.current.removeDirectory('knowledge/empty')).toBe(false);
  });
  expect(result.current.copy?.pendingCreate).toEqual(original);
  expect(result.current.pendingDirectories).toEqual(['knowledge/empty']);
});
it.each([
  'knowledge/Scripts',
  'knowledge/Worktrees',
  'knowledge/' + '界'.repeat(200),
  'knowledge/ padded',
  'knowledge/bad:folder',
])('does not stage an unsafe folder %s or call the API', async (path) => {
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  fetch.mockClear();
  act(() => {
    expect(result.current.createDirectory(path)).toBe(false);
  });
  expect(result.current.copy).toBeNull();
  expect(result.current.pendingDirectories).toEqual([]);
  expect(result.current.error).toContain('Choose a folder');
  expect(result.current.canSave).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
it('reads the original accepted path separately after an edited move', async () => {
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  await act(async () => {
    await result.current.openDocument(catalog.documents[0]);
  });
  act(() => result.current.change('working text'));
  act(() => result.current.moveDocument('knowledge/a.md', 'knowledge/moved/a.md'));
  fetch.mockClear();
  const before = localStorage.getItem(key);
  await act(async () => {
    expect(await result.current.readDocument(catalog.documents[0])).toEqual({
      content: 'original',
    });
  });
  expect(fetch.mock.calls[0][0]).toContain('path=knowledge%2Fa.md');
  expect(localStorage.getItem(key)).toBe(before);
  expect(
    await result.current.readDocument({
      path: 'knowledge/moved/a.md',
      title: 'A',
      area: 'knowledge',
    }),
  ).toEqual({ content: 'working text' });
});
it('reports document opening failure and cancelled replacement without confirming selection', async () => {
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  fetch.mockRejectedValueOnce(new Error('offline'));
  await act(async () => {
    expect(await result.current.openDocument(catalog.documents[0])).toBe(false);
  });
  await act(async () => {
    expect(await result.current.openDocument(catalog.documents[0])).toBe(true);
  });
  act(() => result.current.change('local'));
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  await act(async () => {
    expect(
      await result.current.openDocument({
        path: 'knowledge/other.md',
        title: 'Other',
        area: 'knowledge',
      }),
    ).toBe(false);
  });
  expect(result.current.selected?.content).toBe('local');
});
it('cancels a saved sole-folder change through its version-fenced review workflow before removing local operations', async () => {
  const draft = {
    id: 'folder-only',
    title: 'Folder',
    baseRevision: 'base',
    version: 3,
    state: 'in-review',
    documents: [],
    directories: ['knowledge/empty'],
    review: {
      url: 'https://github.com/example/knowledge/pull/1',
      head: 'head',
      version: 3,
      ready: true,
    },
    updatedAt: '',
  };
  localStorage.setItem(
    key,
    JSON.stringify({
      title: draft.title,
      baseRevision: 'base',
      draft,
      documents: [],
      directories: draft.directories,
      savedDirectories: draft.directories,
      selected: '',
      saved: '[]',
    }),
  );
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  let resolve!: (value: unknown) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let cancellation!: Promise<boolean>;
  act(() => {
    cancellation = result.current.removeDirectory('knowledge/empty');
  });
  expect(result.current.pendingDirectories).toEqual(['knowledge/empty']);
  expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/knowledge/drafts/folder-only/cancel');
  expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toEqual({ version: 3 });
  await act(async () => {
    resolve({ ok: true, json: async () => ({ draft: { ...draft, state: 'closed' } }) });
    expect(await cancellation).toBe(true);
  });
  expect(result.current.pendingDirectories).toEqual([]);
  expect(result.current.copy?.draft).toMatchObject({ state: 'closed', review: draft.review });
  expect(result.current.dirty).toBe(false);
});
it('retries an uncertain saved-folder cancellation with the same saved version and receipt', async () => {
  const draft = {
    id: 'folder-only',
    title: 'Folder',
    baseRevision: 'base',
    version: 3,
    state: 'draft',
    documents: [],
    directories: ['knowledge/empty'],
    updatedAt: '',
  };
  localStorage.setItem(
    key,
    JSON.stringify({
      title: draft.title,
      baseRevision: 'base',
      draft,
      documents: [],
      directories: draft.directories,
      savedDirectories: draft.directories,
      selected: '',
      saved: '[]',
    }),
  );
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  fetch.mockRejectedValueOnce(new Error('lost cancellation response'));
  await act(async () => {
    expect(await result.current.removeDirectory('knowledge/empty')).toBe(false);
  });
  expect(result.current.pendingDirectories).toEqual(draft.directories);
  expect(result.current.copy?.draft?.version).toBe(3);
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ draft: { ...draft, state: 'closed' } }),
  });
  await act(async () => {
    expect(await result.current.removeDirectory('knowledge/empty')).toBe(true);
  });
  const calls = fetch.mock.calls.filter(([url]) => url.endsWith('/cancel'));
  expect(calls).toHaveLength(2);
  expect(calls.map(([, init]) => JSON.parse(init.body))).toEqual([{ version: 3 }, { version: 3 }]);
});
it('preserves a sole saved folder on a cancellation conflict and requires saved comparison', async () => {
  const draft = {
    id: 'folder-only',
    title: 'Folder',
    baseRevision: 'base',
    version: 3,
    state: 'draft',
    documents: [],
    directories: ['knowledge/empty'],
    updatedAt: '',
  };
  localStorage.setItem(
    key,
    JSON.stringify({
      title: draft.title,
      baseRevision: 'base',
      draft,
      documents: [],
      directories: draft.directories,
      savedDirectories: draft.directories,
      selected: '',
      saved: '[]',
    }),
  );
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  fetch.mockResolvedValueOnce({
    ok: false,
    status: 409,
    json: async () => ({ error: 'changed elsewhere' }),
  });
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ draft: { ...draft, version: 4, directories: ['knowledge/other'] } }),
  });
  await act(async () => {
    expect(await result.current.removeDirectory('knowledge/empty')).toBe(false);
  });
  expect(result.current.pendingDirectories).toEqual(draft.directories);
  expect(result.current.copy?.initialSaveConflict?.version).toBe(4);
  fetch.mockClear();
  await act(async () => {
    expect(await result.current.removeDirectory('knowledge/empty')).toBe(false);
  });
  expect(fetch).not.toHaveBeenCalled();
});
it('requires saving excluded documents before last-folder cancellation can close a saved document review', async () => {
  const document = { path: 'knowledge/a.md', base: 'original', content: 'reviewed document edit' };
  const draft = {
    id: 'document-and-folder',
    title: 'Change',
    baseRevision: 'base',
    version: 3,
    state: 'in-review' as const,
    documents: [document],
    directories: ['knowledge/empty'],
    review: {
      url: 'https://github.com/example/knowledge/pull/1',
      head: 'saved-document-head',
      version: 3,
      ready: true,
    },
    updatedAt: '',
  };
  localStorage.setItem(
    key,
    JSON.stringify({
      title: draft.title,
      baseRevision: 'base',
      draft,
      documents: draft.documents,
      directories: draft.directories,
      savedDirectories: draft.directories,
      selected: document.path,
      saved: JSON.stringify(draft.documents),
    }),
  );
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ ...catalog, revision: 'latest', documents: [] }),
  });
  await act(async () => {
    await result.current.compare();
  });
  await act(async () => {
    await result.current.excludeRemovedDocuments();
  });
  expect(result.current.copy?.documents).toEqual([]);
  expect(result.current.copy?.draft?.documents).toEqual([document]);
  fetch.mockClear();
  await act(async () => {
    expect(await result.current.removeDirectory('knowledge/empty')).toBe(false);
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(result.current.pendingDirectories).toEqual(draft.directories);
  expect(result.current.copy?.draft?.review).toEqual(draft.review);
  expect(result.current.error).toContain('Save the document removal');
  const folderDraft = {
    ...draft,
    version: 4,
    baseRevision: 'latest',
    documents: [],
    review: { ...draft.review, version: 4, head: 'folder-head', ready: false },
  };
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ draft: folderDraft }) });
  await act(async () => {
    await result.current.save();
  });
  expect(fetch.mock.calls[0][0]).toBe('/api/knowledge/drafts/document-and-folder');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
    version: 3,
    documents: [],
    directories: draft.directories,
  });
  expect(result.current.copy?.draft?.documents).toEqual([]);
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ draft: { ...folderDraft, state: 'closed' } }),
  });
  await act(async () => {
    expect(await result.current.removeDirectory('knowledge/empty')).toBe(true);
  });
  expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/knowledge/drafts/document-and-folder/cancel');
  expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toEqual({ version: 4 });
});
it('rejects an occupied accepted directory rather than reporting an unstaged creation', async () => {
  fetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ ...catalog, directories: ['knowledge', 'knowledge/existing'] }),
  }));
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  fetch.mockClear();
  expect(result.current.canCreateDirectory('knowledge/existing')).toBe(false);
  act(() => {
    expect(result.current.createDirectory('knowledge/existing')).toBe(false);
  });
  expect(result.current.error).toContain('already exists');
  expect(result.current.copy).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
  expect(result.current.canSave).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects duplicate pending folders while preserving the existing operation', async () => {
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  act(() => {
    expect(result.current.createDirectory('knowledge/new')).toBe(true);
  });
  const before = localStorage.getItem(key);
  expect(result.current.canCreateDirectory('knowledge/new')).toBe(false);
  act(() => {
    expect(result.current.createDirectory('knowledge/new')).toBe(false);
  });
  expect(result.current.error).toContain('already exists');
  expect(result.current.pendingDirectories).toEqual(['knowledge/new']);
  expect(localStorage.getItem(key)).toBe(before);
});
it('allows a valid folder parent even when its new-folder child is occupied, without accepting outside scopes or files', async () => {
  fetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      ...catalog,
      documentPaths: ['knowledge/enrolled'],
      directories: ['knowledge', 'knowledge/enrolled', 'knowledge/enrolled/new-folder'],
      documents: [{ path: 'knowledge/enrolled/a.md', title: 'A', area: 'knowledge' }],
    }),
  }));
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  expect(result.current.canCreateInDirectory('knowledge/enrolled')).toBe(true);
  expect(result.current.canCreateDirectory('knowledge/enrolled/new-folder')).toBe(false);
  expect(result.current.canCreateInDirectory('knowledge')).toBe(false);
  expect(result.current.canCreateInDirectory('knowledge/enrolled/a.md')).toBe(false);
});
it('atomically stages a confirmed accepted move while preserving existing edits and receipts', async () => {
  const existing = { path: 'knowledge/other.md', base: 'before', content: 'local edit' };
  const draft = {
    id: 'draft',
    title: 'Existing',
    baseRevision: 'base',
    version: 3,
    state: 'draft',
    documents: [existing],
    updatedAt: '',
  };
  const pendingCreate = {
    requestId: 'existing-request',
    title: 'Existing',
    baseRevision: 'base',
    documents: [{ path: existing.path, content: 'before' }],
    directories: [],
  };
  localStorage.setItem(
    key,
    JSON.stringify({
      title: draft.title,
      baseRevision: 'base',
      draft,
      pendingCreate,
      documents: [existing],
      directories: [],
      selected: existing.path,
      saved: JSON.stringify([existing]),
    }),
  );
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  const before = localStorage.getItem(key);
  let resolve!: (value: unknown) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let move!: Promise<boolean>;
  act(() => {
    move = result.current.moveAcceptedDocument(catalog.documents[0], 'knowledge/new/a.md');
  });
  expect(localStorage.getItem(key)).toBe(before);
  expect(result.current.busy).toBe(true);
  await act(async () => {
    resolve({ ok: true, json: async () => ({ content: 'original' }) });
    expect(await move).toBe(true);
  });
  expect(result.current.copy?.documents).toEqual([
    existing,
    {
      path: 'knowledge/new/a.md',
      sourcePath: 'knowledge/a.md',
      base: 'original',
      content: 'original',
    },
  ]);
  expect(result.current.copy?.draft).toEqual(draft);
  expect(result.current.copy?.pendingCreate).toEqual(pendingCreate);
  expect(result.current.selected?.path).toBe('knowledge/new/a.md');
});
it('preserves the entire working copy on failed accepted-move reads and rejects older bases before fetching', async () => {
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  await act(async () => {
    await result.current.openDocument(catalog.documents[0]);
  });
  act(() => result.current.change('local edit'));
  const before = localStorage.getItem(key);
  const another = { path: 'knowledge/other.md', title: 'Other', area: 'knowledge' };
  fetch.mockRejectedValueOnce(new Error('offline'));
  await act(async () => {
    expect(await result.current.moveAcceptedDocument(another, 'knowledge/new/other.md')).toBe(
      false,
    );
  });
  expect(localStorage.getItem(key)).toBe(before);
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...catalog, revision: 'newer' }) });
  await act(async () => {
    await result.current.refresh();
  });
  fetch.mockClear();
  await act(async () => {
    expect(await result.current.moveAcceptedDocument(another, 'knowledge/new/other.md')).toBe(
      false,
    );
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).toBe(before);
});
it('moves an already staged accepted source without fetching or losing its edits', async () => {
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  await act(async () => {
    await result.current.openDocument(catalog.documents[0]);
  });
  act(() => result.current.change('local edit'));
  fetch.mockClear();
  await act(async () => {
    expect(
      await result.current.moveAcceptedDocument(catalog.documents[0], 'knowledge/new/a.md'),
    ).toBe(true);
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(result.current.selected).toMatchObject({
    path: 'knowledge/new/a.md',
    sourcePath: 'knowledge/a.md',
    content: 'local edit',
  });
});
it('preserves the frozen creation and folders if an exact replay acknowledges a newer remote version', async () => {
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  act(() => result.current.createDirectory('knowledge/empty'));
  fetch.mockRejectedValueOnce(new Error('lost response'));
  await act(async () => {
    await result.current.save();
  });
  const original = result.current.copy!.pendingCreate!;
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      draft: {
        id: original.requestId,
        title: original.title,
        baseRevision: original.baseRevision,
        version: 2,
        state: 'draft',
        documents: [],
        directories: original.directories,
        updatedAt: '',
      },
    }),
  });
  await act(async () => {
    expect(await result.current.removeDirectory('knowledge/empty')).toBe(false);
  });
  expect(result.current.copy?.pendingCreate).toEqual(original);
  expect(result.current.pendingDirectories).toEqual(original.directories);
  expect(result.current.copy?.initialSaveConflict?.version).toBe(2);
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/cancel'))).toBe(false);
});
it('resets editor history when explicitly reopening a moved document while retaining text and folder operations', async () => {
  const { result } = renderHook(useKnowledgeLibrary);
  await waitFor(() => expect(result.current.catalog).toBeTruthy());
  await act(async () => {
    await result.current.openDocument(catalog.documents[0]);
  });
  act(() => result.current.change('first edit'));
  act(() => result.current.moveDocument('knowledge/a.md', 'knowledge/new/a.md'));
  act(() => result.current.change('retained edit'));
  act(() => result.current.createDirectory('knowledge/empty'));
  const initial = result.current.historyResetKey;
  expect(result.current.canUndo).toBe(true);
  fetch.mockClear();
  await act(async () => {
    expect(
      await result.current.openDocument({
        path: 'knowledge/new/a.md',
        title: 'A',
        area: 'knowledge',
      }),
    ).toBe(true);
  });
  expect(result.current.historyResetKey).toBeGreaterThan(initial);
  expect(result.current.canUndo).toBe(false);
  expect(result.current.selected).toMatchObject({
    path: 'knowledge/new/a.md',
    sourcePath: 'knowledge/a.md',
    content: 'retained edit',
  });
  expect(result.current.pendingDirectories).toEqual(['knowledge/empty']);
  expect(fetch).not.toHaveBeenCalled();
});

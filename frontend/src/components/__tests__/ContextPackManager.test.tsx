// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ContextPackManager } from '../ContextPackManager';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(cleanup);
beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(apiFetch).mockClear();
});
const importedDefinition = {
  version: 1,
  id: 'pack-b',
  name: 'Pack B',
  description: '',
  tokenBudget: 4000,
  documents: [
    {
      path: 'hub/review.md',
      revision: 'a'.repeat(40),
      mode: 'required',
      headings: [],
      priority: 50,
    },
  ],
  retrievalGuidance: '',
};
const draftA = {
  id: 'draft-a',
  version: 1,
  state: 'draft',
  baseRevision: 0,
  definition: { ...importedDefinition, id: 'pack-a', name: 'Pack A' },
};
const revisionA = { revision: 7, definition: draftA.definition };
const impactA = { name: 'Profile using A', profileId: 'profile-a', revision: 2 };
function importPack(value = importedDefinition) {
  fireEvent.click(screen.getByRole('button', { name: 'Import pack JSON' }));
  fireEvent.change(screen.getByLabelText('Portable context pack JSON'), {
    target: { value: JSON.stringify(value) },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review imported pack' }));
}
function renderManager() {
  return render(
    <MemoryRouter>
      <ContextPackManager knowledge={knowledge} />
    </MemoryRouter>,
  );
}
it('clears pack A review evidence on import and keeps it absent after saving and publishing B', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const result =
      path === '/api/context-packs'
        ? { packs: [], drafts: [draftA] }
        : path.endsWith('/revisions')
          ? { revisions: [revisionA] }
          : path.endsWith('/impact')
            ? { profiles: [impactA] }
            : path.endsWith('/preview')
              ? {
                  compiledContext: {
                    source: 'packs',
                    compilerRevision: 'compiler-a',
                    recipeHash: 'recipe-a',
                    payloadHash: 'payload-a',
                    provenance: {
                      packs: [{ id: 'pack-a', revision: 7, hash: 'proof-a' }],
                      documents: [],
                      omissions: [],
                    },
                    context: {
                      tokenCount: 1,
                      tokenBudget: 4000,
                      sourceCount: 0,
                      sources: [],
                      trimmed: [],
                      fullMarkdown: 'Compiled pack A',
                    },
                  },
                }
              : path.endsWith('/publish')
                ? { pack: { revision: 1, definition: importedDefinition } }
                : {
                    draft: {
                      id: 'draft-b',
                      version: 1,
                      state: 'draft',
                      definition: JSON.parse(String(init?.body)).definition,
                    },
                  };
    return { ok: true, json: async () => result } as Response;
  });
  renderManager();
  fireEvent.click(await screen.findByRole('button', { name: /Pack A/ }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Revision comparison and affected profiles' }),
  );
  expect(await screen.findByText(/Profile using A/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Compile pack preview' }));
  expect(await screen.findByText('Compiled pack A')).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Import pack JSON' })).toBeEnabled(),
  );
  importPack({ ...importedDefinition, version: 99 });
  expect(screen.getByLabelText('Pack name')).toHaveValue('Pack A');
  expect(screen.getByText('Compiled pack A')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Portable context pack JSON'), {
    target: { value: JSON.stringify(importedDefinition) },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review imported pack' }));
  const expectNoA = () => {
    expect(screen.getByLabelText('Pack name')).toHaveValue('Pack B');
    expect(screen.queryByText('Compiled pack A')).toBeNull();
    expect(screen.queryByText('proof-a')).toBeNull();
    expect(screen.queryByText(/Profile using A/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'View pack revision 7' })).toBeNull();
  };
  expectNoA();
  fireEvent.click(screen.getByRole('button', { name: 'Save pack draft' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Draft saved'));
  expectNoA();
  fireEvent.click(screen.getByRole('button', { name: 'Publish pack revision' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Published revision 1'));
  expectNoA();
});
it.each(['import', 'new'] as const)(
  'ignores late pack A lookups after %s replaces the copy',
  async (replacement) => {
    let history!: (response: Response) => void;
    let impact!: (response: Response) => void;
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path.endsWith('/revisions'))
        return new Promise<Response>((resolve) => {
          history = resolve;
        });
      if (path.endsWith('/impact'))
        return new Promise<Response>((resolve) => {
          impact = resolve;
        });
      return { ok: true, json: async () => ({ packs: [], drafts: [draftA] }) } as Response;
    });
    renderManager();
    fireEvent.click(await screen.findByRole('button', { name: /Pack A/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Revision comparison and affected profiles' }),
    );
    if (replacement === 'import') importPack();
    else fireEvent.click(screen.getByRole('button', { name: 'New pack' }));
    await act(async () => {
      history({ ok: true, json: async () => ({ revisions: [revisionA] }) } as Response);
      impact({ ok: true, json: async () => ({ profiles: [impactA] }) } as Response);
    });
    expect(screen.queryByRole('button', { name: 'View pack revision 7' })).toBeNull();
    expect(screen.queryByText(/Profile using A/)).toBeNull();
  },
);
it('ignores late lookup errors after import and clears previous lookup errors on New', async () => {
  let history!: (cause: Error) => void;
  let impact!: (cause: Error) => void;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path.endsWith('/revisions'))
      return new Promise<Response>((_, reject) => {
        history = reject;
      });
    if (path.endsWith('/impact'))
      return new Promise<Response>((_, reject) => {
        impact = reject;
      });
    return { ok: true, json: async () => ({ packs: [], drafts: [draftA] }) } as Response;
  });
  renderManager();
  fireEvent.click(await screen.findByRole('button', { name: /Pack A/ }));
  importPack();
  await act(async () => {
    history(Error('late'));
    impact(Error('late'));
  });
  expect(screen.getByRole('status')).toHaveTextContent('Imported working copy');
  fireEvent.click(screen.getByRole('button', { name: 'Discard pack edits' }));
  fireEvent.click(screen.getByRole('button', { name: /Pack A/ }));
  await act(async () => {
    history(Error('unavailable'));
    impact(Error('unavailable'));
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Revision comparison and affected profiles' }),
  );
  expect(screen.getByText('Revision history unavailable.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'New pack' }));
  expect(screen.queryByText('Revision history unavailable.')).toBeNull();
  expect(screen.queryByText(/Profile impact is unavailable/)).toBeNull();
});
const knowledge = {
  revision: 'a'.repeat(40),
  documents: [{ path: 'hub/review.md', title: 'Review guidance', area: 'Hub' }],
  drafts: [],
  reviewEnabled: true,
  acceptanceEnabled: true,
  syncedAt: null,
};
it('pins accepted documents, preserves failed-save edits and requires explicit publication', async () => {
  let fail = true;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    let result: unknown = { packs: [], drafts: [] };
    let ok = true;
    if (path === '/api/context-packs/drafts') {
      if (fail) {
        ok = false;
        result = { error: 'Concurrent edit. Your copy is preserved.' };
      } else
        result = {
          draft: {
            id: 'draft-1',
            version: 1,
            baseRevision: 0,
            definition: JSON.parse(String(init?.body)).definition,
          },
        };
    }
    return { ok, json: async () => result } as Response;
  });
  const view = render(
    <MemoryRouter>
      <ContextPackManager knowledge={knowledge} />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'New pack' }));
  fireEvent.change(screen.getByLabelText('Pack name'), { target: { value: 'Mitzo reviewer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add accepted document' }));
  expect(screen.getByText(knowledge.revision)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save pack draft' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Concurrent edit');
  expect(screen.getByLabelText('Pack name')).toHaveValue('Mitzo reviewer');
  expect(screen.getByRole('button', { name: 'Publish pack revision' })).toBeDisabled();
  view.unmount();
  render(
    <MemoryRouter>
      <ContextPackManager knowledge={knowledge} />
    </MemoryRouter>,
  );
  expect(await screen.findByLabelText('Pack name')).toHaveValue('Mitzo reviewer');
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Save pack draft' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Draft saved'));
  const retryBodies = vi
    .mocked(apiFetch)
    .mock.calls.filter(([path]) => path === '/api/context-packs/drafts')
    .map(([, init]) => JSON.parse(String(init?.body)));
  expect(retryBodies[0].requestId).toBeTruthy();
  expect(retryBodies[1].requestId).toBe(retryBodies[0].requestId);
  const save = vi
    .mocked(apiFetch)
    .mock.calls.slice()
    .reverse()
    .find(([path]) => path === '/api/context-packs/drafts');
  expect(JSON.parse(String(save?.[1]?.body)).definition.documents[0]).toMatchObject({
    path: 'hub/review.md',
    revision: knowledge.revision,
    mode: 'prioritized',
  });
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.endsWith('/publish'))).toBe(false);
});
it('keeps navigation recovery when browser storage writes are unavailable', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ packs: [], drafts: [] }),
  } as Response);
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('Storage unavailable');
  });
  const view = render(
    <MemoryRouter>
      <ContextPackManager knowledge={knowledge} />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'New pack' }));
  fireEvent.change(screen.getByLabelText('Pack name'), { target: { value: 'Memory copy' } });
  view.unmount();
  render(
    <MemoryRouter>
      <ContextPackManager knowledge={knowledge} />
    </MemoryRouter>,
  );
  expect(await screen.findByLabelText('Pack name')).toHaveValue('Memory copy');
  fireEvent.click(screen.getByRole('button', { name: 'Discard pack edits' }));
  storage.mockRestore();
});
it('opens immutable historical revisions for comparison before creating another draft', async () => {
  const definition = {
    version: 1,
    id: 'review',
    name: 'Current review',
    description: '',
    tokenBudget: 4000,
    documents: [
      {
        path: 'hub/review.md',
        revision: knowledge.revision,
        mode: 'required',
        headings: [],
        priority: 50,
      },
    ],
    retrievalGuidance: '',
  };
  const latest = {
    id: 'review',
    revision: 3,
    hash: 'b'.repeat(64),
    publishedAt: '2026-10-10T10:00:00Z',
    definition,
  };
  const previous = {
    ...latest,
    revision: 2,
    definition: { ...definition, name: 'Previous review' },
  };
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      ({
        ok: true,
        json: async () =>
          path === '/api/context-packs'
            ? { packs: [latest], drafts: [] }
            : path.endsWith('/revisions')
              ? { revisions: [latest, previous] }
              : { profiles: [] },
      }) as Response,
  );
  render(
    <MemoryRouter>
      <ContextPackManager knowledge={knowledge} />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /Current review/ }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Revision comparison and affected profiles' }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'View pack revision 2' }));
  expect(screen.getByLabelText('Pack name')).toHaveValue('Previous review');
  expect(screen.getByRole('button', { name: 'Publish pack revision' })).toBeDisabled();
});
it('prepares the curator with bounded accepted references and selected immutable pack metadata', async () => {
  const definition = {
    version: 1,
    id: 'review',
    name: 'Review sources',
    description: 'Review accepted decisions',
    tokenBudget: 4000,
    documents: [
      {
        path: 'hub/review.md',
        revision: knowledge.revision,
        mode: 'required',
        headings: [],
        priority: 50,
      },
    ],
    retrievalGuidance: '',
  };
  const pack = {
    id: 'review',
    revision: 3,
    hash: 'b'.repeat(64),
    publishedAt: '2026-10-10T10:00:00Z',
    definition,
  };
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      ({
        ok: true,
        json: async () =>
          path === '/api/context-packs'
            ? { packs: [pack], drafts: [] }
            : path.endsWith('/revisions')
              ? { revisions: [pack] }
              : { profiles: [] },
      }) as Response,
  );
  render(
    <MemoryRouter>
      <ContextPackManager
        knowledge={{
          ...knowledge,
          documents: [
            ...knowledge.documents,
            { path: '/Users/private/secret.md', title: 'Private source', area: 'Private' },
          ],
        }}
      />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /Review sources/ }));
  const prompt = new URL(
    screen.getByRole('link', { name: 'Create context with advisor' }).getAttribute('href')!,
    'https://mitzo-ui.test',
  ).searchParams.get('prompt')!;
  expect(prompt).toContain(knowledge.revision);
  expect(prompt).toContain('hub/review.md');
  expect(prompt).toContain('"revision":3');
  expect(prompt).toContain(pack.hash);
  expect(prompt).toContain('Review accepted decisions');
  expect(prompt).not.toContain('/Users/private');
  expect(prompt).toContain('manual import');
  expect(screen.getByLabelText('Pack preview budget')).toBeTruthy();
  expect(screen.getByText(/final profile recipe budget controls/)).toBeTruthy();
});

// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { KnowledgeLibrary } from '../KnowledgeLibrary';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn(), getApiBaseUrl: () => '' }));
const draft = {
  id: 'd1',
  title: 'Working principles',
  baseRevision: 'r1',
  version: 1,
  documents: [{ path: 'hub/principles.md', base: '# Principles', content: '# Revised' }],
  updatedAt: '2026-10-09T10:00:00Z',
  state: 'in-review',
  review: {
    url: 'https://github.com/example/knowledge/pull/1',
    head: 'h1',
    version: 1,
    ready: true,
  },
};
const catalog = {
  revision: 'r1',
  documents: [
    { path: 'hub/principles.md', title: 'Working principles', area: 'Hub' },
    { path: 'teams/release.md', title: 'Release process', area: 'Teams' },
  ],
  drafts: [],
  reviewEnabled: true,
  acceptanceEnabled: true,
  syncedAt: null,
};
function response(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response;
}
async function findLibraryDocument(name: RegExp, folder = 'hub') {
  const parent = await screen.findByRole('button', { name: `Folder ${folder}` });
  if (parent.getAttribute('aria-expanded') === 'false') fireEvent.click(parent);
  return screen.findByRole('button', { name });
}
function setup() {
  return render(
    <MemoryRouter>
      <KnowledgeLibrary />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  localStorage.clear();
  let createdDocuments = draft.documents;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/knowledge' || path === '/api/knowledge/refresh') return response(catalog);
    if (path.startsWith('/api/knowledge/document'))
      return response({ path: 'hub/principles.md', revision: 'r1', content: '# Principles' });
    if (path === '/api/knowledge/drafts') {
      createdDocuments = JSON.parse(String(init?.body)).documents.map(
        (d: { path: string; content: string }) => ({ ...d, base: '# Principles' }),
      );
      return response({
        draft: { ...draft, documents: createdDocuments, state: 'draft', review: undefined },
      });
    }
    if (path.endsWith('/review'))
      return response({ draft: { ...draft, documents: createdDocuments } });
    if (init?.method === 'PUT')
      return response({
        draft: {
          ...draft,
          version: 2,
          documents: JSON.parse(String(init.body)).documents.map(
            (d: { path: string; content: string }) => ({ ...d, base: '# Principles' }),
          ),
        },
        reviewError: 'Accepted document changed. Compare before saving again.',
      });
    return response({ draft });
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('curates accepted documents by search and area and opens a read-only reader before Edit', async () => {
  setup();
  await findLibraryDocument(/Working principles/);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Release' } });
  expect(screen.queryByRole('button', { name: /Working principles/ })).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: /Working principles/ }));
  await screen.findByRole('article', { name: 'Working principles' });
  expect(screen.queryByRole('textbox', { name: 'Document source' })).toBeNull();
  expect(localStorage.getItem('mitzo-knowledge-working-copy:')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  await screen.findByRole('textbox', { name: 'Document source' });
  for (const name of ['Source', 'Preview', 'Split', 'Undo', 'Redo', 'Save'])
    expect(screen.getByRole('button', { name })).toBeTruthy();
  expect(screen.queryByRole('complementary', { name: 'Review details' })).toBeNull();
});
it('Save durably creates a draft and opens review without exposing Git workflow', async () => {
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  const input = await screen.findByRole('textbox', { name: 'Document source' });
  fireEvent.change(input, { target: { value: '# Revised' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('In review');
  expect(
    vi.mocked(apiFetch).mock.calls.find(([path]) => path === '/api/knowledge/drafts')?.[1]?.body,
  ).toContain('"baseRevision":"r1"');
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.endsWith('/d1/review'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Review details' }));
  expect(screen.getByRole('link', { name: 'Open review' }).getAttribute('href')).toBe(
    draft.review.url,
  );
  expect(screen.getByRole('button', { name: 'Accept changes' })).toBeTruthy();
});
it('recovers unsaved work across remounts and preserves it on a review conflict', async () => {
  const first = setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Recovered' },
  });
  first.unmount();
  setup();
  expect(
    ((await screen.findByRole('textbox', { name: 'Document source' })) as HTMLTextAreaElement)
      .value,
  ).toBe('# Recovered');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('In review');
  fireEvent.change(screen.getByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Keep this' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Accepted document changed. Compare before saving again.');
  expect(
    (screen.getByRole('textbox', { name: 'Document source' }) as HTMLTextAreaElement).value,
  ).toBe('# Keep this');
  expect(screen.getByRole('button', { name: 'Compare accepted version' })).toBeTruthy();
});
it('does not offer acceptance for a stale review or disabled acceptance', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    path === '/api/knowledge/drafts/d1'
      ? response({ draft })
      : response({ ...catalog, acceptanceEnabled: false, drafts: [draft] }),
  );
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Drafts (1)' }));
  fireEvent.click(screen.getByRole('button', { name: /Working principles/ }));
  await screen.findByRole('textbox', { name: 'Document source' });
  fireEvent.click(screen.getByRole('button', { name: 'Review details' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept changes' })).toBeNull());
});
it('accepts only after reconciling the exact current review and reports waiting publication', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.endsWith('/reconcile')) return response({ draft, canAccept: true, currentHead: 'h1' });
    if (path.endsWith('/accept')) return response({ draft: { ...draft, state: 'accepted' } });
    return original(path, init);
  });
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Revised' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('In review');
  fireEvent.click(screen.getByRole('button', { name: 'Review details' }));
  const accept = screen.getByRole('button', { name: 'Accept changes' }) as HTMLButtonElement;
  expect(accept.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Check review status' }));
  await waitFor(() => expect(accept.disabled).toBe(false));
  fireEvent.click(accept);
  await screen.findAllByText('Accepted · Waiting for publication');
  expect(vi.mocked(apiFetch).mock.calls.find(([path]) => path.endsWith('/accept'))?.[1]?.body).toBe(
    '{"version":1,"head":"h1"}',
  );
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
});
it('keeps a failed review draft and requires an explicit choice before rebasing', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/knowledge/refresh') return response({ ...catalog, revision: 'r2' });
    if (path.startsWith('/api/knowledge/document') && path.includes('r2'))
      return response({ content: '# New accepted' });
    return original(path, init);
  });
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Revised' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('In review');
  fireEvent.change(screen.getByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Keep this' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Accepted document changed. Compare before saving again.');
  fireEvent.click(screen.getByRole('button', { name: 'Compare accepted version' }));
  await screen.findByText('# New accepted');
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(
    1,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Keep my draft and save' }));
  await waitFor(() =>
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT'),
    ).toHaveLength(2),
  );
  const puts = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(String(puts[1][1]?.body))).toMatchObject({
    version: 2,
    baseRevision: 'r2',
    documents: [{ path: 'hub/principles.md', content: '# Keep this' }],
  });
});
it('undoes and redoes edits, and guards unloading while changes are unsaved', async () => {
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  const input = (await screen.findByRole('textbox', {
    name: 'Document source',
  })) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '# First' } });
  fireEvent.change(input, { target: { value: '# Second' } });
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(input.value).toBe('# First');
  fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
  expect(input.value).toBe('# Second');
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
});
it('starts a new change from retained edits after explicitly comparing accepted knowledge', async () => {
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Revised' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('In review');
  fireEvent.click(screen.getByRole('button', { name: 'Review details' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start new change' }));
  await screen.findByRole('button', { name: 'Keep my edits in a new change' });
  fireEvent.click(screen.getByRole('button', { name: 'Keep my edits in a new change' }));
  await waitFor(() =>
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/knowledge/drafts'),
    ).toHaveLength(2),
  );
});
it('retries an uncertain first save with the same persisted request identity', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let attempt = 0;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/knowledge/drafts' && attempt++ === 0)
      throw new Error('Connection lost before acknowledgement');
    return original(path, init);
  });
  const first = setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Revised' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Connection lost before acknowledgement');
  first.unmount();
  setup();
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Revised' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('In review');
  const bodies = vi
    .mocked(apiFetch)
    .mock.calls.filter(([path]) => path === '/api/knowledge/drafts')
    .map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(bodies[1]).toEqual(bodies[0]);
});
it('loads draft content on demand from a lightweight catalog summary', async () => {
  const summary = { ...draft, documents: draft.documents.map(({ path }) => ({ path })) };
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    path === '/api/knowledge/drafts/d1'
      ? response({
          draft: {
            ...draft,
            documents: [{ ...draft.documents[0], content: '# Loaded only when opened' }],
          },
        })
      : response({ ...catalog, drafts: [summary] }),
  );
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Drafts (1)' }));
  fireEvent.click(screen.getByRole('button', { name: /Working principles/ }));
  await waitFor(() =>
    expect(
      (screen.getByRole('textbox', { name: 'Document source' }) as HTMLTextAreaElement).value,
    ).toBe('# Loaded only when opened'),
  );
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/knowledge/drafts/d1')).toBe(
    true,
  );
});
it('sends the exact saved review draft for review, preserving its source and requiring saved edits', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.endsWith('/review'))
      return response({ draft: { ...draft, review: { ...draft.review, ready: false } } });
    if (path.endsWith('/ready'))
      return response({
        draft: { ...draft, review: { ...draft.review, ready: true } },
        canAccept: false,
      });
    return original(path, init);
  });
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  const source = (await screen.findByRole('textbox', {
    name: 'Document source',
  })) as HTMLTextAreaElement;
  fireEvent.change(source, { target: { value: '# Revised' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Review draft saved');
  fireEvent.click(screen.getByRole('button', { name: 'Review details' }));
  const send = screen.getByRole('button', { name: 'Send for review' }) as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  fireEvent.change(source, { target: { value: '# Unsaved' } });
  expect(send.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(source.value).toBe('# Revised');
  expect(send.disabled).toBe(false);
  fireEvent.click(send);
  await screen.findByText('Sent for review');
  expect(source.value).toBe('# Revised');
  expect(vi.mocked(apiFetch).mock.calls.find(([path]) => path.endsWith('/ready'))?.[1]?.body).toBe(
    '{"version":1,"head":"h1"}',
  );
  expect(screen.queryByRole('button', { name: 'Send for review' })).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Accept changes' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
it('preserves a saved review draft when sending for review fails', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.endsWith('/review'))
      return response({ draft: { ...draft, review: { ...draft.review, ready: false } } });
    if (path.endsWith('/ready'))
      return response({ error: 'Review head changed. Refresh review status.' }, false);
    return original(path, init);
  });
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Revised' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Review draft saved');
  fireEvent.click(screen.getByRole('button', { name: 'Review details' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send for review' }));
  await screen.findByText('Review head changed. Refresh review status.');
  expect(
    (screen.getByRole('textbox', { name: 'Document source' }) as HTMLTextAreaElement).value,
  ).toBe('# Revised');
  expect(
    (screen.getByRole('button', { name: 'Send for review' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(screen.queryByText('Sent for review')).toBeNull();
});
it('requires a fresh review submission after saving newer document edits', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'PUT')
      return response({
        draft: {
          ...draft,
          version: 2,
          review: { ...draft.review, version: 2, ready: false },
          documents: [{ ...draft.documents[0], content: '# Updated' }],
        },
      });
    return original(path, init);
  });
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Revised' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('In review');
  fireEvent.click(screen.getByRole('button', { name: 'Review details' }));
  expect(screen.queryByRole('button', { name: 'Send for review' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Updated' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findAllByText('Review draft saved');
  expect(
    (screen.getByRole('button', { name: 'Send for review' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(
    (screen.getByRole('button', { name: 'Accept changes' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
it('does not create empty drafts or change a clean confirmed ready review on Save', async () => {
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  const source = (await screen.findByRole('textbox', {
    name: 'Document source',
  })) as HTMLTextAreaElement;
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(source, { key: 's', ctrlKey: true });
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/knowledge/drafts')).toBe(
    false,
  );
  fireEvent.change(source, { target: { value: '# Revised' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('In review');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  const before = vi.mocked(apiFetch).mock.calls.length;
  fireEvent.keyDown(source, { key: 's', ctrlKey: true });
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls).toHaveLength(before));
  const saved = JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!);
  expect(saved.draft).toMatchObject({
    version: 1,
    review: { head: 'h1', version: 1, ready: true },
  });
});
it('retries an unconfirmed review at the same saved version without saving new document content', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let attempts = 0;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.endsWith('/review') && attempts++ === 0)
      return response({
        draft: {
          ...draft,
          state: 'draft',
          review: undefined,
          publication: { head: 'h1', version: 1 },
          error: 'Review connection lost',
        },
        reviewError: 'Review connection lost',
      });
    return original(path, init);
  });
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Revised' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Review connection lost');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('In review');
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  const reviews = vi.mocked(apiFetch).mock.calls.filter(([path]) => path.endsWith('/review'));
  expect(reviews).toHaveLength(2);
  for (const [, init] of reviews) expect(JSON.parse(String(init?.body))).toEqual({ version: 1 });
});
it('does not retry a clean unconfirmed review while review publishing is disabled', async () => {
  const unconfirmed = {
    ...draft,
    state: 'draft',
    review: undefined,
    publication: { head: 'h1', version: 1 },
    error: 'Review unavailable',
  };
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    path === '/api/knowledge/drafts/d1'
      ? response({ draft: unconfirmed })
      : response({ ...catalog, reviewEnabled: false, drafts: [unconfirmed] }),
  );
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Drafts (1)' }));
  fireEvent.click(screen.getByRole('button', { name: /Working principles/ }));
  const source = await screen.findByRole('textbox', { name: 'Document source' });
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  const before = vi.mocked(apiFetch).mock.calls.length;
  fireEvent.keyDown(source, { key: 's', ctrlKey: true });
  expect(vi.mocked(apiFetch).mock.calls).toHaveLength(before);
});
it.each(['# Revised', '# Further local'])(
  'blocks further saves after an uncertain first save finds an advanced remote draft (%s)',
  async (ownContent) => {
    const original = vi.mocked(apiFetch).getMockImplementation()!;
    let attempts = 0;
    const advanced = {
      ...draft,
      version: 2,
      documents: [{ ...draft.documents[0], content: '# Other device' }],
      review: { ...draft.review, version: 2, head: 'h2' },
    };
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path === '/api/knowledge/drafts') {
        if (attempts++ === 0) throw new Error('Lost first acknowledgement');
        return response({ draft: advanced });
      }
      if (init?.method === 'PUT')
        return response({
          draft: {
            ...advanced,
            version: 3,
            documents: [{ ...advanced.documents[0], content: ownContent }],
            review: { ...advanced.review, version: 3, ready: false },
          },
        });
      return original(path, init);
    });
    const view = setup();
    fireEvent.click(await findLibraryDocument(/Working principles/));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
      target: { value: '# Revised' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Lost first acknowledgement');
    fireEvent.change(screen.getByRole('textbox', { name: 'Document source' }), {
      target: { value: ownContent },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('region', { name: 'Compare saved draft and working copy' });
    expect(
      (screen.getByRole('textbox', { name: 'Document source' }) as HTMLTextAreaElement).value,
    ).toBe(ownContent);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    const recovery = JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!);
    expect(recovery.draft).toBeUndefined();
    expect(recovery.pendingCreate).toBeTruthy();
    const before = vi.mocked(apiFetch).mock.calls.length;
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Document source' }), {
      key: 's',
      ctrlKey: true,
    });
    expect(vi.mocked(apiFetch).mock.calls).toHaveLength(before);
    view.unmount();
    setup();
    await screen.findByRole('region', { name: 'Compare saved draft and working copy' });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole('textbox', { name: 'Document source' }) as HTMLTextAreaElement).value,
    ).toBe(ownContent);
    expect(screen.getByText('# Other device')).toBeTruthy();
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Keep my edits and update saved draft' }));
    await screen.findByText('Review draft saved');
    const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({
      version: 2,
      documents: [{ path: 'hub/principles.md', content: ownContent }],
    });
  },
);
it('keeps the conflict when explicit reconciliation races another save and lets the operator refresh and use the saved version', async () => {
  const own = [{ ...draft.documents[0], content: '# My recovered edits' }];
  const remote = {
    ...draft,
    version: 2,
    documents: [{ ...draft.documents[0], content: '# First remote' }],
    review: { ...draft.review, version: 2, head: 'h2' },
  };
  const newer = {
    ...remote,
    version: 3,
    documents: [{ ...draft.documents[0], content: '# Newer remote' }],
    review: { ...draft.review, version: 3, head: 'h3' },
  };
  localStorage.setItem(
    'mitzo-knowledge-working-copy:',
    JSON.stringify({
      title: draft.title,
      baseRevision: 'r1',
      documents: own,
      selected: own[0].path,
      saved: JSON.stringify(draft.documents),
      pendingCreate: {
        requestId: '6ec86a54-f5e2-4d6e-9b0b-28ef33df97b2',
        title: draft.title,
        baseRevision: 'r1',
        documents: own.map(({ path, content }) => ({ path, content })),
      },
      initialSaveConflict: remote,
    }),
  );
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    init?.method === 'PUT'
      ? response({ error: 'Draft changed in another window. Reload before saving.' }, false)
      : path === '/api/knowledge/drafts/d1'
        ? response({ draft: newer })
        : response(catalog),
  );
  setup();
  const source = (await screen.findByRole('textbox', {
    name: 'Document source',
  })) as HTMLTextAreaElement;
  fireEvent.click(screen.getByRole('button', { name: 'Keep my edits and update saved draft' }));
  await screen.findByText('Draft changed in another window. Reload before saving.');
  expect(source.value).toBe('# My recovered edits');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  const before = vi.mocked(apiFetch).mock.calls.length;
  fireEvent.keyDown(source, { key: 's', ctrlKey: true });
  expect(vi.mocked(apiFetch).mock.calls).toHaveLength(before);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved comparison' }));
  await screen.findByText('# Newer remote');
  expect(source.value).toBe('# My recovered edits');
  fireEvent.click(screen.getByRole('button', { name: 'Use saved draft' }));
  expect(source.value).toBe('# Newer remote');
  expect(screen.queryByRole('region', { name: 'Compare saved draft and working copy' })).toBeNull();
  const saved = JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!);
  expect(saved.draft.version).toBe(3);
  expect(saved.pendingCreate).toBeUndefined();
  expect(saved.initialSaveConflict).toBeUndefined();
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(
    1,
  );
});
it('preserves edits on an existing draft version conflict and reconciles using the compared saved version', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let writes = 0;
  const remote = {
    ...draft,
    version: 2,
    documents: [{ ...draft.documents[0], content: '# Saved by another device' }],
    review: { ...draft.review, version: 2, head: 'h2' },
  };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'PUT') {
      if (writes++ === 0)
        return {
          ...response({ error: 'Draft changed in another window. Reload before saving.' }, false),
          status: 409,
        };
      return response({
        draft: {
          ...remote,
          version: 3,
          documents: [{ ...remote.documents[0], content: '# My local edits' }],
          review: { ...remote.review, version: 3, ready: false },
        },
      });
    }
    if (path === '/api/knowledge/drafts/d1') return response({ draft: remote });
    return original(path, init);
  });
  const view = setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Revised' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('In review');
  fireEvent.change(screen.getByRole('textbox', { name: 'Document source' }), {
    target: { value: '# My local edits' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('region', { name: 'Compare saved draft and working copy' });
  expect(screen.getByText('# Saved by another device')).toBeTruthy();
  const recovery = JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!);
  expect(recovery.draft.version).toBe(1);
  expect(recovery.initialSaveConflict.version).toBe(2);
  expect(
    (screen.getByRole('textbox', { name: 'Document source' }) as HTMLTextAreaElement).value,
  ).toBe('# My local edits');
  view.unmount();
  setup();
  await screen.findByRole('region', { name: 'Compare saved draft and working copy' });
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  const before = vi.mocked(apiFetch).mock.calls.length;
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Document source' }), {
    key: 's',
    ctrlKey: true,
  });
  expect(vi.mocked(apiFetch).mock.calls).toHaveLength(before);
  fireEvent.click(screen.getByRole('button', { name: 'Keep my edits and update saved draft' }));
  await screen.findByText('Review draft saved');
  const puts = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(puts).toHaveLength(2);
  expect(JSON.parse(String(puts[1][1]?.body))).toMatchObject({
    version: 2,
    documents: [{ path: 'hub/principles.md', content: '# My local edits' }],
  });
});
it('keeps a failed saved-version fetch recoverable without allowing writes until comparison is refreshed', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let reads = 0;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'PUT')
      return { ...response({ error: 'Draft changed in another window.' }, false), status: 409 };
    if (path === '/api/knowledge/drafts/d1') {
      if (reads++ === 0) throw new Error('Offline');
      return response({
        draft: {
          ...draft,
          version: 2,
          documents: [{ ...draft.documents[0], content: '# Current saved content' }],
          review: { ...draft.review, version: 2 },
        },
      });
    }
    return original(path, init);
  });
  const view = setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Revised' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('In review');
  fireEvent.change(screen.getByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Keep local' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText(
    'The latest saved version is unavailable. Refresh the comparison to continue.',
  );
  expect(
    (screen.getByRole('textbox', { name: 'Document source' }) as HTMLTextAreaElement).value,
  ).toBe('# Keep local');
  for (const name of ['Save', 'Use saved draft', 'Keep my edits and update saved draft'])
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  view.unmount();
  setup();
  await screen.findByText(
    'The latest saved version is unavailable. Refresh the comparison to continue.',
  );
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved comparison' }));
  await screen.findByText('# Current saved content');
  expect(
    (
      screen.getByRole('button', {
        name: 'Keep my edits and update saved draft',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(
    (screen.getByRole('textbox', { name: 'Document source' }) as HTMLTextAreaElement).value,
  ).toBe('# Keep local');
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(
    1,
  );
});
it('recovers a lost update acknowledgement through saved comparison when the next write finds the same remote content', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let writes = 0;
  const remote = {
    ...draft,
    version: 2,
    documents: [{ ...draft.documents[0], content: '# Saved before the connection broke' }],
    review: { ...draft.review, version: 2, head: 'h2' },
  };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'PUT') {
      if (writes++ === 0) throw new Error('Lost update acknowledgement');
      return { ...response({ error: 'Draft changed in another window.' }, false), status: 409 };
    }
    if (path === '/api/knowledge/drafts/d1') return response({ draft: remote });
    return original(path, init);
  });
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Revised' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('In review');
  fireEvent.change(screen.getByRole('textbox', { name: 'Document source' }), {
    target: { value: remote.documents[0].content },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Lost update acknowledgement');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('region', { name: 'Compare saved draft and working copy' });
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Keep my edits and update saved draft' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('region', { name: 'Compare saved draft and working copy' }),
    ).toBeNull(),
  );
  expect(
    (screen.getByRole('textbox', { name: 'Document source' }) as HTMLTextAreaElement).value,
  ).toBe(remote.documents[0].content);
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(
    2,
  );
  const saved = JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!);
  expect(saved.draft).toMatchObject({
    version: 2,
    review: { version: 2, head: 'h2', ready: true },
  });
});
it('explicitly excludes catalog-confirmed removed documents while preserving and rebasing surviving edits', async () => {
  const removed = {
    path: 'hub/principles.md',
    base: '# Old principles',
    content: '# Removed draft edits',
  };
  const surviving = {
    path: 'teams/release.md',
    base: '# Old release',
    content: '# Keep release edits',
  };
  const change = {
    ...draft,
    documents: [removed, surviving],
    error: 'Compare accepted knowledge before saving',
  };
  const latest = {
    ...catalog,
    revision: 'r2',
    documents: [catalog.documents[1]],
    drafts: [change],
  };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/knowledge') return response({ ...catalog, drafts: [change] });
    if (path === '/api/knowledge/refresh') return response(latest);
    if (path === '/api/knowledge/drafts/d1' && init?.method === 'GET')
      return response({ draft: change });
    if (path.startsWith('/api/knowledge/document')) {
      if (path.includes('hub%2Fprinciples'))
        return { ...response({ error: 'Not found' }, false), status: 404 };
      return response({ content: '# Latest release' });
    }
    if (init?.method === 'PUT')
      return response({
        draft: {
          ...change,
          error: undefined,
          version: 2,
          baseRevision: 'r2',
          documents: [{ ...surviving, base: '# Latest release' }],
          review: { ...draft.review, version: 2, ready: false },
        },
      });
    return response({ draft: change });
  });
  const view = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Drafts (1)' }));
  fireEvent.click(screen.getByRole('button', { name: /Working principles/ }));
  await screen.findByText('Compare accepted knowledge before saving');
  const before = localStorage.getItem('mitzo-knowledge-working-copy:');
  fireEvent.click(screen.getByRole('button', { name: 'Compare accepted version' }));
  await screen.findByText('No longer in accepted knowledge');
  expect(localStorage.getItem('mitzo-knowledge-working-copy:')).toBe(before);
  expect(
    within(screen.getByRole('region', { name: 'Compare accepted and draft' })).getByText(
      '# Removed draft edits',
    ),
  ).toBeTruthy();
  expect(screen.getByText('# Keep release edits')).toBeTruthy();
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(
        ([path]) => path.startsWith('/api/knowledge/document') && path.includes('hub%2Fprinciples'),
      ),
  ).toBe(false);
  view.unmount();
  setup();
  await screen.findByRole('textbox', { name: 'Document source' });
  expect(JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!).documents).toEqual([
    removed,
    surviving,
  ]);
  // Recover the stored review error and reconcile this draft without changing its identity.
  fireEvent.click(screen.getByRole('button', { name: 'Compare accepted version' }));
  await screen.findByText('No longer in accepted knowledge');
  await screen.findByRole('button', { name: 'Exclude removed documents and save' });
  fireEvent.click(screen.getByRole('button', { name: 'Exclude removed documents and save' }));
  await screen.findAllByText('Review draft saved');
  const put = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({
    version: 1,
    baseRevision: 'r2',
    documents: [{ path: 'teams/release.md', content: '# Keep release edits' }],
  });
  expect(
    (screen.getByRole('textbox', { name: 'Document source' }) as HTMLTextAreaElement).value,
  ).toBe('# Keep release edits');
});
it('recovers an explicitly emptied draft and adds a current document using the latest accepted base', async () => {
  const removed = {
    path: 'hub/principles.md',
    base: '# Old principles',
    content: '# Removed only edits',
  };
  const change = {
    ...draft,
    documents: [removed],
    error: 'Compare accepted knowledge before saving',
  };
  let refreshed = false;
  const currentDoc = { path: 'teams/renamed.md', title: 'Current release notes', area: 'Teams' };
  const latest = { ...catalog, revision: 'r2', documents: [currentDoc], drafts: [change] };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/knowledge')
      return response(refreshed ? latest : { ...catalog, drafts: [change] });
    if (path === '/api/knowledge/refresh') {
      refreshed = true;
      return response(latest);
    }
    if (path === '/api/knowledge/drafts/d1' && init?.method === 'GET')
      return response({ draft: change });
    if (path.startsWith('/api/knowledge/document'))
      return response({ content: '# Current accepted notes' });
    if (init?.method === 'PUT')
      return response({
        draft: {
          ...change,
          error: undefined,
          version: 2,
          baseRevision: 'r2',
          documents: [
            {
              path: currentDoc.path,
              base: '# Current accepted notes',
              content: '# New notes edits',
            },
          ],
          review: { ...draft.review, version: 2, ready: false },
        },
      });
    return response({ draft: change });
  });
  const view = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Drafts (1)' }));
  fireEvent.click(screen.getByRole('button', { name: /Working principles/ }));
  await screen.findByText('Compare accepted knowledge before saving');
  fireEvent.click(screen.getByRole('button', { name: 'Compare accepted version' }));
  await screen.findByText('No longer in accepted knowledge');
  expect(JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!).documents).toEqual([
    removed,
  ]);
  fireEvent.click(
    screen.getByRole('button', { name: 'Exclude removed documents and choose a document' }),
  );
  expect(JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!).documents).toEqual([]);
  view.unmount();
  setup();
  fireEvent.click(await screen.findByRole('button', { name: '+ Add document' }));
  fireEvent.click(await findLibraryDocument(/Current release notes/, 'teams'));
  const source = (await screen.findByRole('textbox', {
    name: 'Document source',
  })) as HTMLTextAreaElement;
  expect(source.value).toBe('# Current accepted notes');
  const read = vi
    .mocked(apiFetch)
    .mock.calls.find(([path]) => path.startsWith('/api/knowledge/document'));
  expect(read?.[0]).toContain('revision=r2');
  fireEvent.change(source, { target: { value: '# New notes edits' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Review draft saved');
  const put = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({
    version: 1,
    baseRevision: 'r2',
    documents: [{ path: 'teams/renamed.md', content: '# New notes edits' }],
  });
});
it.each([404, 401])(
  'preserves the draft when a catalog-listed document read fails with %s instead of classifying it as removed',
  async (status) => {
    const original = vi.mocked(apiFetch).getMockImplementation()!;
    const change = { ...draft, error: 'Compare accepted knowledge before saving' };
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path === '/api/knowledge') return response({ ...catalog, drafts: [change] });
      if (path === '/api/knowledge/drafts/d1') return response({ draft: change });
      if (path.startsWith('/api/knowledge/document'))
        return { ...response({ error: 'Accepted document could not be read' }, false), status };
      return original(path, init);
    });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Drafts (1)' }));
    fireEvent.click(screen.getByRole('button', { name: /Working principles/ }));
    await screen.findByText('Compare accepted knowledge before saving');
    const before = localStorage.getItem('mitzo-knowledge-working-copy:');
    fireEvent.click(screen.getByRole('button', { name: 'Compare accepted version' }));
    await screen.findByText('Accepted document could not be read');
    expect(screen.queryByText('No longer in accepted knowledge')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Exclude removed documents and save' })).toBeNull();
    expect(localStorage.getItem('mitzo-knowledge-working-copy:')).toBe(before);
  },
);
it.each(['accepted', 'closed'])(
  'forks retained local edits from a terminal %s saved conflict after accepted comparison and reload',
  async (state) => {
    const own = [{ ...draft.documents[0], content: '# My unfinished edits' }];
    const terminal = {
      ...draft,
      state,
      version: 2,
      documents: [{ ...draft.documents[0], content: '# Finished remote' }],
      review: { ...draft.review, version: 2, head: 'h2' },
    };
    const oldRequest = '6ec86a54-f5e2-4d6e-9b0b-28ef33df97b2';
    localStorage.setItem(
      'mitzo-knowledge-working-copy:',
      JSON.stringify({
        title: draft.title,
        baseRevision: 'r1',
        draft,
        documents: own,
        selected: own[0].path,
        saved: JSON.stringify(draft.documents),
        pendingCreate: {
          requestId: oldRequest,
          title: draft.title,
          baseRevision: 'r1',
          documents: own.map(({ path, content }) => ({ path, content })),
        },
        initialSaveConflict: terminal,
      }),
    );
    let created: typeof draft | undefined;
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path === '/api/knowledge' || path === '/api/knowledge/refresh')
        return response({ ...catalog, revision: 'r2' });
      if (path.startsWith('/api/knowledge/document'))
        return response({ content: '# Current accepted principles' });
      if (path === '/api/knowledge/drafts') {
        const body = JSON.parse(String(init?.body));
        created = {
          ...draft,
          id: body.requestId,
          baseRevision: body.baseRevision,
          documents: body.documents.map((document: { path: string; content: string }) => ({
            ...document,
            base: '# Current accepted principles',
          })),
        };
        return response({ draft: { ...created, state: 'draft', review: undefined } });
      }
      if (path.endsWith('/review'))
        return response({
          draft: { ...created, review: { ...draft.review, head: 'new-head', ready: false } },
        });
      return response({ draft: terminal });
    });
    const view = setup();
    await screen.findByRole('region', { name: 'Compare saved draft and working copy' });
    fireEvent.click(screen.getByRole('button', { name: 'Start new change with my edits' }));
    await screen.findByText('# Current accepted principles');
    let recovery = JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!);
    expect(recovery.documents).toEqual(own);
    expect(recovery.draft).toBeUndefined();
    expect(recovery.pendingCreate).toBeUndefined();
    expect(recovery.initialSaveConflict).toBeUndefined();
    view.unmount();
    setup();
    await screen.findByRole('textbox', { name: 'Document source' });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Compare accepted version' }));
    await screen.findByText('# Current accepted principles');
    fireEvent.click(screen.getByRole('button', { name: 'Keep my edits in a new change' }));
    await screen.findByText('Review draft saved');
    const post = vi.mocked(apiFetch).mock.calls.find(([path]) => path === '/api/knowledge/drafts');
    const body = JSON.parse(String(post?.[1]?.body));
    expect(body).toMatchObject({
      baseRevision: 'r2',
      documents: [{ path: 'hub/principles.md', content: '# My unfinished edits' }],
    });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.requestId).not.toBe(oldRequest);
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    recovery = JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!);
    expect(recovery.draft.id).toBe(body.requestId);
  },
);
it.each(['accepted', 'closed', 'in-review'])(
  'keeps fork intent when a %s change loses all accepted documents before a replacement is selected',
  async (state) => {
    const removed = {
      path: 'hub/principles.md',
      base: '# Old principles',
      content: '# Removed retained edits',
    };
    const finished = { ...draft, state, documents: [removed] };
    const currentDoc = { path: 'teams/renamed.md', title: 'Replacement document', area: 'Teams' };
    const latest = { ...catalog, revision: 'r2', documents: [currentDoc], drafts: [finished] };
    let created: typeof draft | undefined;
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path === '/api/knowledge' || path === '/api/knowledge/refresh') return response(latest);
      if (path === '/api/knowledge/drafts/d1') return response({ draft: finished });
      if (path.startsWith('/api/knowledge/document'))
        return response({ content: '# Current replacement' });
      if (path === '/api/knowledge/drafts') {
        const body = JSON.parse(String(init?.body));
        created = {
          ...draft,
          id: body.requestId,
          baseRevision: body.baseRevision,
          documents: body.documents.map((document: { path: string; content: string }) => ({
            ...document,
            base: '# Current replacement',
          })),
        };
        return response({ draft: { ...created, state: 'draft', review: undefined } });
      }
      if (path.endsWith('/review'))
        return response({
          draft: { ...created, review: { ...draft.review, head: 'new-head', ready: false } },
        });
      return response({ draft: finished });
    });
    const view = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Drafts (1)' }));
    fireEvent.click(screen.getByRole('button', { name: /Working principles/ }));
    await screen.findByRole('textbox', { name: 'Document source' });
    fireEvent.click(screen.getByRole('button', { name: 'Review details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start new change' }));
    await screen.findByText('No longer in accepted knowledge');
    fireEvent.click(
      screen.getByRole('button', { name: 'Exclude removed documents and choose a document' }),
    );
    const empty = JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!);
    expect(empty.documents).toEqual([]);
    expect(empty.draft).toBeUndefined();
    expect(empty.pendingCreate).toBeUndefined();
    view.unmount();
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '+ Add document' }));
    fireEvent.click(await findLibraryDocument(/Replacement document/, 'teams'));
    const source = await screen.findByRole('textbox', { name: 'Document source' });
    fireEvent.change(source, { target: { value: '# New replacement edits' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Review draft saved');
    const post = vi.mocked(apiFetch).mock.calls.find(([path]) => path === '/api/knowledge/drafts');
    const body = JSON.parse(String(post?.[1]?.body));
    expect(body.baseRevision).toBe('r2');
    expect(body.requestId).not.toBe('d1');
    expect(body.documents).toEqual([{ path: currentDoc.path, content: '# New replacement edits' }]);
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  },
);
it('preserves an ordinary new-change intent across reload and retries its lost acknowledgement with one fresh request identity', async () => {
  let attempts = 0;
  let created: typeof draft | undefined;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/knowledge' || path === '/api/knowledge/refresh')
      return response({ ...catalog, drafts: [draft] });
    if (path === '/api/knowledge/drafts/d1') return response({ draft });
    if (path.startsWith('/api/knowledge/document')) return response({ content: '# Principles' });
    if (path === '/api/knowledge/drafts') {
      const body = JSON.parse(String(init?.body));
      created = {
        ...draft,
        id: body.requestId,
        baseRevision: body.baseRevision,
        documents: body.documents.map((document: { path: string; content: string }) => ({
          ...document,
          base: '# Principles',
        })),
      };
      if (attempts++ === 0) throw new Error('New draft acknowledgement lost');
      return response({ draft: { ...created, state: 'draft', review: undefined } });
    }
    if (path.endsWith('/review'))
      return response({
        draft: { ...created, review: { ...draft.review, ready: false, head: 'fresh-head' } },
      });
    return response({ draft });
  });
  let view = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Drafts (1)' }));
  fireEvent.click(screen.getByRole('button', { name: /Working principles/ }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Forked local edits' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review details' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start new change' }));
  await screen.findByText('# Principles');
  view.unmount();
  view = setup();
  const source = await screen.findByRole('textbox', { name: 'Document source' });
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  const before = vi.mocked(apiFetch).mock.calls.length;
  fireEvent.keyDown(source, { key: 's', ctrlKey: true });
  expect(vi.mocked(apiFetch).mock.calls).toHaveLength(before);
  fireEvent.click(screen.getByRole('button', { name: 'Compare accepted version' }));
  await screen.findByText('# Principles');
  fireEvent.click(screen.getByRole('button', { name: 'Keep my edits in a new change' }));
  await screen.findByText('New draft acknowledgement lost');
  const pending = JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!);
  expect(pending.draft).toBeUndefined();
  expect(pending.pendingCreate.requestId).toMatch(/^[0-9a-f-]{36}$/);
  view.unmount();
  setup();
  await screen.findByRole('textbox', { name: 'Document source' });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Review draft saved');
  const bodies = vi
    .mocked(apiFetch)
    .mock.calls.filter(([path]) => path === '/api/knowledge/drafts')
    .map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0].requestId).toBe(pending.pendingCreate.requestId);
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
});

it('keeps matching documents inside their folder ancestors and expands empty folders', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    path === '/api/knowledge'
      ? response({
          ...catalog,
          directories: ['hub', 'hub/empty', 'hub/context'],
          documents: [{ path: 'hub/context/guide.md', title: 'Voice guide', area: 'Hub' }],
        })
      : original(path, init),
  );
  setup();
  fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'Voice' } });
  expect(screen.getByRole('button', { name: 'Folder hub' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Folder hub/context' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Voice guide/ })).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Folder hub' }));
  fireEvent.click(screen.getByRole('button', { name: 'Folder hub/empty' }));
  expect(screen.getByText('This folder is empty.')).toBeTruthy();
});

it('creates a folder under an explicit parent and saves a folder-only change', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/knowledge') return response({ ...catalog, directories: ['hub'] });
    if (path === '/api/knowledge/drafts') {
      const body = JSON.parse(String(init?.body));
      return response({
        draft: {
          ...draft,
          state: 'draft',
          review: undefined,
          documents: [],
          directories: body.directories,
        },
      });
    }
    if (path.endsWith('/review'))
      return response({ draft: { ...draft, documents: [], directories: ['hub/guides'] } });
    return original(path, init);
  });
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Folder hub' }));
  fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
  expect(screen.getByRole('dialog', { name: 'New folder' }).textContent).toContain('hub');
  fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), {
    target: { value: 'guides' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
  await screen.findByText('New folder: hub/guides');
  expect(screen.queryByRole('textbox', { name: 'Document source' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/knowledge/drafts')).toBe(
      true,
    ),
  );
  const body = JSON.parse(
    String(
      vi.mocked(apiFetch).mock.calls.find(([path]) => path === '/api/knowledge/drafts')?.[1]?.body,
    ),
  );
  expect(body.directories).toEqual(['hub/guides']);
  expect(body.documents).toEqual([]);
});

it('moves a document through same-area folder choices and preserves edited content', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    path === '/api/knowledge'
      ? response({
          ...catalog,
          directories: ['hub', 'hub/context', 'teams'],
          documentPaths: ['hub', 'teams'],
        })
      : original(path, init),
  );
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Keep edits when moved' },
  });
  fireEvent.click(screen.getByRole('button', { name: '← Library' }));
  fireEvent.click(screen.getByRole('button', { name: 'Options for hub/principles.md' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move document' }));
  const dialog = await screen.findByRole('dialog', { name: 'Move document' });
  expect(within(dialog).queryByRole('button', { name: 'Folder teams' })).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Folder hub/context' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }));
  await screen.findByText('Moved: hub/principles.md → hub/context/principles.md');
  fireEvent.click(screen.getByRole('button', { name: 'Resume editing' }));
  expect(
    ((await screen.findByRole('textbox', { name: 'Document source' })) as HTMLTextAreaElement)
      .value,
  ).toBe('# Keep edits when moved');
});

it('lets an invalid pending folder be removed without discarding unrelated document edits', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/knowledge') return response({ ...catalog, directories: ['hub'] });
    return original(path, init);
  });
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Retain these edits' },
  });
  fireEvent.click(screen.getByRole('button', { name: '← Library' }));
  fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
  const dialog = screen.getByRole('dialog', { name: 'New folder' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Folder hub' }));
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Folder name' }), {
    target: { value: 'collision' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create folder' }));
  await screen.findByText('New folder: hub/collision');
  fireEvent.click(screen.getByRole('button', { name: 'Remove new folder hub/collision' }));
  await waitFor(() => expect(screen.queryByText('New folder: hub/collision')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Resume editing' }));
  expect(
    ((await screen.findByRole('textbox', { name: 'Document source' })) as HTMLTextAreaElement)
      .value,
  ).toBe('# Retain these edits');
});

it('starts an organization change when moving an unopened accepted document', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    path === '/api/knowledge'
      ? response({
          ...catalog,
          directories: ['hub', 'hub/context', 'teams'],
          documentPaths: ['hub', 'teams'],
        })
      : original(path, init),
  );
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Folder hub' }));
  fireEvent.click(screen.getByRole('button', { name: 'Options for hub/principles.md' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move document' }));
  const dialog = await screen.findByRole('dialog', { name: 'Move document' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Folder hub/context' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }));
  await screen.findByText('Moved: hub/principles.md → hub/context/principles.md');
  expect(screen.queryByRole('textbox', { name: 'Document source' })).toBeNull();
  const stored = JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!);
  expect(stored.documents).toEqual([
    {
      path: 'hub/context/principles.md',
      sourcePath: 'hub/principles.md',
      base: '# Principles',
      content: '# Principles',
    },
  ]);
});

it('starts with compact collapsed areas and preserves user expansion while searching', async () => {
  setup();
  const hub = await screen.findByRole('button', { name: 'Folder hub' });
  expect(hub.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: /Working principles/ })).toBeNull();
  fireEvent.click(hub);
  expect(screen.getByRole('button', { name: /Working principles/ })).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Release' } });
  expect(screen.getByRole('button', { name: /Release process/ })).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
  expect(screen.getByRole('button', { name: /Working principles/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Release process/ })).toBeNull();
});

it('keeps the requested reader visible when Edit cannot load its working copy', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let reads = 0;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.startsWith('/api/knowledge/document') && ++reads === 2)
      throw new Error('Editing is temporarily unavailable');
    return original(path, init);
  });
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  await screen.findByRole('article', { name: 'Working principles' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  await screen.findByText('Editing is temporarily unavailable');
  expect(screen.getByRole('article', { name: 'Working principles' })).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Document source' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  await screen.findByRole('textbox', { name: 'Document source' });
});
it('keeps the requested reader when replacing an unrelated edited document is cancelled', async () => {
  const own = [{ path: 'hub/principles.md', base: '# Principles', content: '# Keep my edits' }];
  localStorage.setItem(
    'mitzo-knowledge-working-copy:',
    JSON.stringify({
      title: 'Working principles',
      baseRevision: 'r1',
      documents: own,
      selected: own[0].path,
      saved: JSON.stringify(draft.documents),
    }),
  );
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    setup();
    await screen.findByRole('textbox', { name: 'Document source' });
    fireEvent.click(screen.getByRole('button', { name: '← Library' }));
    fireEvent.click(await findLibraryDocument(/Release process/, 'teams'));
    await screen.findByRole('article', { name: 'Release process' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(screen.getByRole('article', { name: 'Release process' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Document source' })).toBeNull();
    expect(JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!).documents).toEqual(
      own,
    );
  } finally {
    confirm.mockRestore();
  }
});
it('keeps Move open without partial edits when confirming a move into an older working copy fails', async () => {
  const own = [{ path: 'hub/principles.md', base: '# Principles', content: '# Keep older edits' }];
  localStorage.setItem(
    'mitzo-knowledge-working-copy:',
    JSON.stringify({
      title: 'Working principles',
      baseRevision: 'r0',
      documents: own,
      selected: own[0].path,
      saved: JSON.stringify(draft.documents),
    }),
  );
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    path === '/api/knowledge'
      ? response({
          ...catalog,
          directories: ['hub', 'teams', 'teams/context'],
          documentPaths: ['hub', 'teams'],
        })
      : original(path, init),
  );
  setup();
  await screen.findByRole('textbox', { name: 'Document source' });
  fireEvent.click(screen.getByRole('button', { name: '← Library' }));
  await findLibraryDocument(/Release process/, 'teams');
  fireEvent.click(screen.getByRole('button', { name: 'Options for teams/release.md' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move document' }));
  const dialog = await screen.findByRole('dialog', { name: 'Move document' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Folder teams/context' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }));
  await screen.findAllByText(/Refresh and compare this draft before/);
  expect(screen.getByRole('dialog', { name: 'Move document' })).toBeTruthy();
  expect(JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!).documents).toEqual(own);
});
it('retains a matching empty folder under the selected area when no documents match search', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    path === '/api/knowledge'
      ? response({ ...catalog, directories: ['hub', 'hub/empty-guides', 'teams'] })
      : original(path, init),
  );
  setup();
  fireEvent.click(await screen.findByRole('button', { name: /^Hub/ }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'empty-guides' } });
  expect(screen.getByRole('button', { name: 'Folder hub' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Folder hub/empty-guides' })).toBeTruthy();
  expect(screen.getByText('This folder is empty.')).toBeTruthy();
});
it('preserves the current reader and offers retry when a linked accepted document fails to load', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let offline = true;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.startsWith('/api/knowledge/document')) {
      if (path.includes('teams%2Frelease.md')) {
        if (offline) throw new Error('Network unavailable');
        return response({ content: '# Release' });
      }
      return response({ content: '# Principles\n\n[Release](../teams/release.md)' });
    }
    return original(path, init);
  });
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  await screen.findByRole('article', { name: 'Working principles' });
  fireEvent.click(screen.getByRole('link', { name: 'Release' }));
  await screen.findByText(/Network unavailable/);
  expect(screen.getByRole('article', { name: 'Working principles' })).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Document source' })).toBeNull();
  offline = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry opening document' }));
  await screen.findByRole('article', { name: 'Release process' });
  expect(localStorage.getItem('mitzo-knowledge-working-copy:')).toBeNull();
});

it('keeps a cancelled folder-only receipt accessible and lets the user explicitly clear it', async () => {
  const folderDraft = {
    ...draft,
    state: 'draft',
    review: undefined,
    documents: [],
    directories: ['hub/guides'],
  };
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/knowledge') return response({ ...catalog, directories: ['hub'] });
    if (path === '/api/knowledge/drafts' || path.endsWith('/review'))
      return response({ draft: folderDraft });
    if (path.endsWith('/cancel')) return response({ draft: { ...folderDraft, state: 'closed' } });
    return original(path, init);
  });
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Folder hub' }));
  fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), {
    target: { value: 'guides' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
  await screen.findByText('New folder: hub/guides');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!).draft?.id).toBe('d1'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove new folder hub/guides' }));
  await screen.findByText('Saved change cancelled.');
  expect(JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!).draft.state).toBe(
    'closed',
  );
  expect((screen.getByRole('button', { name: 'New folder' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  const clear = vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Discard working copy' }));
  expect(clear).toHaveBeenCalled();
  clear.mockRestore();
  expect(localStorage.getItem('mitzo-knowledge-working-copy:')).toBeNull();
  expect((screen.getByRole('button', { name: 'New folder' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});
it('ignores an older linked read after explicitly switching the current reader to Edit', async () => {
  let resolveRead!: (value: Response) => void;
  const pendingRead = new Promise<Response>((resolve) => {
    resolveRead = resolve;
  });
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.startsWith('/api/knowledge/document')) {
      if (path.includes('teams%2Frelease.md')) return pendingRead;
      return response({ content: '# Principles\n\n[Release](../teams/release.md)' });
    }
    return original(path, init);
  });
  setup();
  fireEvent.click(await findLibraryDocument(/Working principles/));
  await screen.findByRole('article', { name: 'Working principles' });
  fireEvent.click(screen.getByRole('link', { name: 'Release' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  await screen.findByRole('textbox', { name: 'Document source' });
  await act(async () => {
    resolveRead(response({ content: '# Slow release' }));
  });
  expect(screen.getByRole('textbox', { name: 'Document source' })).toBeTruthy();
  expect(screen.queryByRole('article', { name: 'Release process' })).toBeNull();
});

it('reads accepted documents after returning from a recovered folder-only working copy', async () => {
  const recovered = {
    title: 'Organize knowledge',
    baseRevision: 'r1',
    documents: [],
    directories: ['hub/new-guides'],
    selected: '',
    saved: '[]',
    savedDirectories: [],
  };
  localStorage.setItem('mitzo-knowledge-working-copy:', JSON.stringify(recovered));
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    path === '/api/knowledge'
      ? response({ ...catalog, directories: ['hub'] })
      : original(path, init),
  );
  setup();
  await screen.findByText('New folder: hub/new-guides');
  fireEvent.click(screen.getByRole('button', { name: '← Library' }));
  const before = localStorage.getItem('mitzo-knowledge-working-copy:');
  fireEvent.click(await findLibraryDocument(/Working principles/));
  await screen.findByRole('article', { name: 'Working principles' });
  expect(screen.queryByRole('textbox', { name: 'Document source' })).toBeNull();
  expect(localStorage.getItem('mitzo-knowledge-working-copy:')).toBe(before);
  expect(JSON.parse(before!).documents).toEqual([]);
});
it('keeps New folder open and preserves the working copy when the name is already occupied', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    path === '/api/knowledge'
      ? response({ ...catalog, directories: ['hub', 'hub/guides'] })
      : original(path, init),
  );
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Folder hub' }));
  fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
  const before = localStorage.getItem('mitzo-knowledge-working-copy:');
  fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), {
    target: { value: 'guides' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
  expect(screen.getByRole('dialog', { name: 'New folder' })).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Create folder' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(localStorage.getItem('mitzo-knowledge-working-copy:')).toBe(before);
});

it('clears empty-copy add intent when a folder becomes the pending change', async () => {
  localStorage.setItem(
    'mitzo-knowledge-working-copy:',
    JSON.stringify({
      title: 'New change',
      baseRevision: 'r1',
      documents: [],
      directories: [],
      selected: '',
      saved: '[]',
      savedDirectories: [],
    }),
  );
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    path === '/api/knowledge'
      ? response({ ...catalog, directories: ['hub'] })
      : original(path, init),
  );
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Folder hub' }));
  fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), {
    target: { value: 'guides' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
  await screen.findByText('New folder: hub/guides');
  const before = localStorage.getItem('mitzo-knowledge-working-copy:');
  fireEvent.click(await findLibraryDocument(/Working principles/));
  await screen.findByRole('article', { name: 'Working principles' });
  expect(screen.queryByRole('textbox', { name: 'Document source' })).toBeNull();
  expect(localStorage.getItem('mitzo-knowledge-working-copy:')).toBe(before);
});

it('opens an accepted file in the reader from a recovered empty change without changing its receipt', async () => {
  const empty = {
    title: 'Retained change',
    baseRevision: 'r1',
    documents: [],
    directories: [],
    selected: '',
    saved: '[]',
    savedDirectories: [],
    draft: { ...draft, state: 'draft', documents: [], review: undefined },
  };
  localStorage.setItem('mitzo-knowledge-working-copy:', JSON.stringify(empty));
  setup();
  await screen.findByRole('button', { name: 'Folder hub' });
  const before = localStorage.getItem('mitzo-knowledge-working-copy:');
  fireEvent.click(await findLibraryDocument(/Working principles/));
  await screen.findByRole('article', { name: 'Working principles' });
  expect(screen.queryByRole('textbox', { name: 'Document source' })).toBeNull();
  expect(localStorage.getItem('mitzo-knowledge-working-copy:')).toBe(before);
});
it('explicitly adds a document to the same recovered empty change and keeps its draft receipt', async () => {
  const empty = {
    title: 'Retained change',
    baseRevision: 'r1',
    documents: [],
    directories: [],
    selected: '',
    saved: '[]',
    savedDirectories: [],
    draft: { ...draft, state: 'draft', documents: [], review: undefined },
  };
  localStorage.setItem('mitzo-knowledge-working-copy:', JSON.stringify(empty));
  setup();
  fireEvent.click(await screen.findByRole('button', { name: '+ Add document' }));
  fireEvent.click(await findLibraryDocument(/Working principles/));
  await screen.findByRole('textbox', { name: 'Document source' });
  const copy = JSON.parse(localStorage.getItem('mitzo-knowledge-working-copy:')!);
  expect(copy.title).toBe('Retained change');
  expect(copy.draft.id).toBe('d1');
  expect(copy.baseRevision).toBe('r1');
  expect(copy.documents).toEqual([
    { path: 'hub/principles.md', base: '# Principles', content: '# Principles' },
  ]);
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/knowledge/drafts')).toBe(
    false,
  );
});

it('cancels an unopened document Move without adding it to the existing working copy', async () => {
  const own = [{ path: 'hub/principles.md', base: '# Principles', content: '# Keep edits' }];
  localStorage.setItem(
    'mitzo-knowledge-working-copy:',
    JSON.stringify({
      title: 'Working principles',
      baseRevision: 'r1',
      documents: own,
      selected: own[0].path,
      saved: JSON.stringify(draft.documents),
    }),
  );
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    path === '/api/knowledge'
      ? response({
          ...catalog,
          directories: ['hub', 'teams', 'teams/context'],
          documentPaths: ['hub', 'teams'],
        })
      : original(path, init),
  );
  setup();
  await screen.findByRole('textbox', { name: 'Document source' });
  fireEvent.click(screen.getByRole('button', { name: '← Library' }));
  await findLibraryDocument(/Release process/, 'teams');
  const before = localStorage.getItem('mitzo-knowledge-working-copy:');
  fireEvent.click(screen.getByRole('button', { name: 'Options for teams/release.md' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move document' }));
  const dialog = await screen.findByRole('dialog', { name: 'Move document' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(localStorage.getItem('mitzo-knowledge-working-copy:')).toBe(before);
  expect(
    vi.mocked(apiFetch).mock.calls.some(([path]) => path.startsWith('/api/knowledge/document')),
  ).toBe(false);
});

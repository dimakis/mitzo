// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
function setup() {
  return render(
    <MemoryRouter>
      <KnowledgeLibrary />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  localStorage.clear();
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/knowledge' || path === '/api/knowledge/refresh') return response(catalog);
    if (path.startsWith('/api/knowledge/document'))
      return response({ path: 'hub/principles.md', revision: 'r1', content: '# Principles' });
    if (path === '/api/knowledge/drafts')
      return response({ draft: { ...draft, state: 'draft', review: undefined } });
    if (path.endsWith('/review')) return response({ draft });
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
it('curates accepted documents by search and area and opens the full editor', async () => {
  setup();
  await screen.findByRole('button', { name: /Working principles/ });
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Release' } });
  expect(screen.queryByRole('button', { name: /Working principles/ })).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: /Working principles/ }));
  await screen.findByRole('textbox', { name: 'Document source' });
  for (const name of ['Source', 'Preview', 'Split', 'Undo', 'Redo', 'Save'])
    expect(screen.getByRole('button', { name })).toBeTruthy();
  expect(screen.queryByRole('complementary', { name: 'Review details' })).toBeNull();
});
it('Save durably creates a draft and opens review without exposing Git workflow', async () => {
  setup();
  fireEvent.click(await screen.findByRole('button', { name: /Working principles/ }));
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
  fireEvent.click(await screen.findByRole('button', { name: /Working principles/ }));
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
  fireEvent.click(await screen.findByRole('button', { name: /Working principles/ }));
  await screen.findByRole('textbox', { name: 'Document source' });
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
  fireEvent.click(await screen.findByRole('button', { name: /Working principles/ }));
  await screen.findByRole('textbox', { name: 'Document source' });
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
  fireEvent.click(await screen.findByRole('button', { name: /Working principles/ }));
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
  fireEvent.click(await screen.findByRole('button', { name: /Working principles/ }));
  await screen.findByRole('textbox', { name: 'Document source' });
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
  fireEvent.click(await screen.findByRole('button', { name: /Working principles/ }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Document source' }), {
    target: { value: '# Revised' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Connection lost before acknowledgement');
  first.unmount();
  setup();
  await screen.findByRole('textbox', { name: 'Document source' });
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
  fireEvent.click(await screen.findByRole('button', { name: /Working principles/ }));
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
  fireEvent.click(await screen.findByRole('button', { name: /Working principles/ }));
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
  fireEvent.click(await screen.findByRole('button', { name: /Working principles/ }));
  await screen.findByRole('textbox', { name: 'Document source' });
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

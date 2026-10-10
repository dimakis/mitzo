// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ContextPackManager } from '../ContextPackManager';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(cleanup);
beforeEach(() => sessionStorage.clear());
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
  const save = vi
    .mocked(apiFetch)
    .mock.calls.findLast(([path]) => path === '/api/context-packs/drafts');
  expect(JSON.parse(String(save?.[1]?.body)).definition.documents[0]).toMatchObject({
    path: 'hub/review.md',
    revision: knowledge.revision,
    mode: 'prioritized',
  });
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.endsWith('/publish'))).toBe(false);
});

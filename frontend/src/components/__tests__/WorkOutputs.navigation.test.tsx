// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { WorkOutputs } from '../WorkOutputs';
import { apiFetch } from '../../lib/api-fetch';
import { installDialogStub } from './dialog-stub';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../UserOutputUpload', () => ({ UserOutputUpload: () => null }));
const id = 'a'.repeat(32);
const version = (revision: number) => ({
  id,
  itemId: 'studio',
  filename: 'studio-plan.md',
  title: 'Studio plan',
  revision,
  size: 30,
  sha256: String(revision).repeat(64),
  url: `/api/telos/artifacts/${id}?revision=${revision}`,
  sourceKind: 'external_codex_report',
  sessionId: 'external-codex:source',
  sourcePath: 'plan.md',
  createdAt: '2026-10-16T10:00:00Z',
});
const response = (value: unknown) =>
  ({ ok: true, status: 200, json: async () => value }) as Response;
function Probe() {
  const l = useLocation();
  return <output aria-label="Current route">{l.pathname + l.search}</output>;
}
function view(path = '/todos/studio?filter=mine') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Probe />
      <WorkOutputs itemId="studio" />
    </MemoryRouter>,
  );
}
let latest = 3;
beforeEach(() => {
  installDialogStub();
  vi.clearAllMocks();
  latest = 3;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const u = new URL(String(url), 'http://fixture');
    if (u.pathname.endsWith('/versions'))
      return response({
        artifacts: [
          version(
            u.searchParams.has('beforeRevision')
              ? Number(u.searchParams.get('beforeRevision')) - 1
              : latest,
          ),
        ],
        cursor: null,
        hasMore: false,
      });
    if (u.pathname.endsWith('/document')) {
      const r = Number(u.searchParams.get('revision'));
      return response({
        path: version(r).url,
        name: 'studio-plan.md',
        ext: '.md',
        content: `# Retained studio plan r${r}\n\nSelected original document.`,
        revision: r,
        editable: true,
        previewUnavailable: false,
      });
    }
    return response({ artifacts: [version(latest)], limit: 100 });
  });
});
afterEach(cleanup);
it('opens one title link and preserves exact revision, route filters and provenance', async () => {
  view();
  const open = await screen.findByRole('link', { name: 'Studio plan' });
  const href = new URL(open.getAttribute('href')!, 'http://fixture');
  expect(href.pathname).toBe('/todos/studio');
  expect(href.searchParams.get('filter')).toBe('mine');
  expect(href.searchParams.get('savedArtifact')).toBe(id);
  expect(href.searchParams.get('savedRevision')).toBe('3');
  expect(href.searchParams.get('savedHash')).toBe('3'.repeat(64));
  fireEvent.click(screen.getByText('Provenance'));
  expect(screen.getByText('external-codex:source')).toBeTruthy();
  expect(screen.getByText('3'.repeat(64))).toBeTruthy();
  expect(screen.getByText('2026-10-16T10:00:00Z')).toBeTruthy();
  expect(screen.getByText('Author not recorded')).toBeTruthy();
  fireEvent.click(open);
  await screen.findByRole('heading', { name: 'Retained studio plan r3' });
  expect(screen.queryByRole('button', { name: 'Open Studio plan' })).toBeNull();
});
it('reloads pinned r3 after r4 appears and reaches Files with a pinned return route', async () => {
  const first = view();
  fireEvent.click(await screen.findByRole('link', { name: 'Studio plan' }));
  await screen.findByRole('heading', { name: 'Retained studio plan r3' });
  const pinned = screen.getByLabelText('Current route').textContent!;
  first.unmount();
  latest = 4;
  view(pinned);
  await screen.findByRole('heading', { name: 'Retained studio plan r3' });
  expect(screen.queryByRole('heading', { name: 'Retained studio plan r4' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'File options' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open', exact: true }));
  await waitFor(() =>
    expect(screen.getByLabelText('Current route').textContent).toContain('/files?'),
  );
  const target = new URL(screen.getByLabelText('Current route').textContent!, 'http://fixture');
  expect(target.searchParams.get('path')).toBe(version(3).url);
  expect(target.searchParams.get('from')).toBe(pinned);
});
it('closing the dialog removes only its owned URL fields and restores the Work route', async () => {
  view();
  fireEvent.click(await screen.findByRole('link', { name: 'Studio plan' }));
  await screen.findByRole('heading', { name: 'Retained studio plan r3' });
  fireEvent.click(screen.getByRole('button', { name: 'Done', exact: true }));
  await waitFor(() =>
    expect(screen.getByLabelText('Current route').textContent).toBe('/todos/studio?filter=mine'),
  );
});

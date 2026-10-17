import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { WorkOutputs } from '../WorkOutputs';
const render = (ui: ReactElement) =>
  rtlRender(ui, {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={['/todos/studio']}>{children}</MemoryRouter>
    ),
  });
vi.mock('../UserOutputUpload', () => ({ UserOutputUpload: () => null }));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          limit: 100,
          artifacts: [
            {
              id: 'a'.repeat(32),
              itemId: 'studio',
              filename: 'plan.md',
              title: 'Studio plan',
              revision: 3,
              size: 30,
              sha256: 'b'.repeat(64),
              sessionId: 'external-codex:source',
              sourceKind: 'external_codex_report',
              sourcePath: 'plan.md',
              createdAt: '2026-10-16T10:00:00Z',
              url: '/api/telos/artifacts/' + 'a'.repeat(32) + '?revision=3',
            },
          ],
        }),
      ),
  ),
}));
afterEach(cleanup);
it('exposes exact saved revision, hash, recorded time and source without inventing authors or update dates', async () => {
  render(<WorkOutputs itemId="studio" />);
  await screen.findByText('Studio plan');
  fireEvent.click(screen.getByText('Provenance'));
  expect(screen.getByText('b'.repeat(64))).toBeTruthy();
  expect(screen.getByText('2026-10-16T10:00:00Z')).toBeTruthy();
  expect(screen.getByText('external-codex:source')).toBeTruthy();
  expect(screen.getByText('Author not recorded')).toBeTruthy();
});

it('opens the selected retained revision in the existing viewer, separately from sharing', async () => {
  render(<WorkOutputs itemId="studio" />);
  const open = await screen.findByRole('link', { name: 'Studio plan' });
  const href = new URL(open.getAttribute('href')!, 'https://offline.test');
  expect(href.pathname).toBe('/files');
  expect(href.searchParams.get('path')).toBe(
    '/api/telos/artifacts/' + 'a'.repeat(32) + '?revision=3',
  );
  expect(screen.getByRole('button', { name: 'Share Studio plan' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Download Studio plan' })).toBeTruthy();
});

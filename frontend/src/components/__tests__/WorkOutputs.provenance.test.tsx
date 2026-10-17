// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkOutputs } from '../WorkOutputs';
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

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TelosSourceWorkLink } from '../TelosSourceWorkLink';
import * as api from '../../lib/api-fetch';
vi.mock('../../hooks/useTodoData', () => ({
  useTodoData: () => ({ items: [{ id: 'item', summary: 'Home studio', children: [] }] }),
  findInTree: (items: unknown[]) => items[0],
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('reopens a worker with the retained exact item and lead references, independently of originating navigation', async () => {
  vi.spyOn(api, 'apiFetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        sessionId: 'worker',
        telosWorkRoleContext: {
          version: 1,
          itemId: 'item',
          role: 'worker',
          brief: { revision: 'brief-r1', sha256: 'a'.repeat(64), text: 'Reviewed acoustic plan' },
          parentCriteria: [],
          overallGoal: { itemId: 'item', revision: 'goal-r1', text: 'Record a first session' },
          sources: [],
          artifacts: [],
          leadConversationId: 'lead',
        },
      }),
      { status: 200 },
    ),
  );
  render(
    <MemoryRouter>
      <TelosSourceWorkLink conversationId="worker" />
    </MemoryRouter>,
  );
  expect((await screen.findByRole('link', { name: 'Home studio' })).getAttribute('href')).toBe(
    '/todos/item',
  );
  expect(screen.getByRole('link', { name: 'Return to lead chat' }).getAttribute('href')).toBe(
    '/chat/lead',
  );
  expect(screen.getByText('Reviewed acoustic plan')).toBeTruthy();
  expect(screen.getByText('Record a first session')).toBeTruthy();
});
it('CT05: reopening consumes verified retained display metadata from session projection without a current-work label fetch', async () => {
  const { sha256Hex } = await import('../../lib/browser-crypto');
  const context = {
    version: 1,
    itemId: 'item',
    role: 'lead',
    brief: { revision: 'brief-r1', sha256: 'a'.repeat(64), text: 'Reviewed acoustic plan' },
    parentCriteria: [],
    overallGoal: { itemId: 'item', revision: 'goal-r1', text: 'Record a first session' },
    sources: [],
    artifacts: [],
  };
  const presentation = {
    version: 1,
    contextSha256: sha256Hex(JSON.stringify(context)),
    reviewedAt: '2026-10-18T10:00:00Z',
    item: { itemId: 'item', revision: 'brief-r1', title: 'Studio session' },
    overallGoal: { itemId: 'item', revision: 'goal-r1', title: 'Reviewed recording goal' },
    parents: [],
    sources: [],
    artifacts: [],
  };
  const presentationRef = {
    id: '89b5166a-c549-4aa8-85f2-65dfbf0f2f81',
    sha256: sha256Hex(JSON.stringify(presentation)),
  };
  const fetch = vi.spyOn(api, 'apiFetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        sessionId: 'lead',
        telosWorkRoleContext: context,
        telosWorkRolePresentation: { presentation, presentationRef },
      }),
      { status: 200 },
    ),
  );
  render(
    <MemoryRouter>
      <TelosSourceWorkLink conversationId="lead" />
    </MemoryRouter>,
  );
  expect(await screen.findByText('Reviewed recording goal')).toBeTruthy();
  expect(screen.getByText('Studio session')).toBeTruthy();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe('/api/sessions/lead/meta');
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { TelosWorkApiClient } from '@mitzo/client';
import { createTestStore } from '../../test-utils/createTestStore';
import { TelosSourceNavigationProvider } from '../../hooks/TelosSourceNavigation';
import { useTelosChatRoute } from '../../hooks/useTelosChatRoute';
import { TelosChatRouteLayout } from '../TelosChatRouteLayout';
import { TelosItemSources } from '../TelosItemSources';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const snapshot = {
  version: 1,
  snapshotId: 'reviewed-exchange',
  itemId: 'slice',
  source: { namespace: 'mitzo', conversationId: 'planning' },
  selection: { kind: 'selected', messageIds: ['agreed'], blockIds: [], throughSequence: 2 },
  author: null,
  sourceCreatedAt: null,
  adoptedAt: null,
  artifacts: [],
  adoptedBrief: null,
};
function Chat() {
  const route = useTelosChatRoute('planning');
  return (
    <TelosChatRouteLayout
      route={route}
      conversationId="planning"
      header={<header>{route.back && <Link to={route.back.path}>Back</Link>}</header>}
    >
      <textarea aria-label="Draft" defaultValue="Planning draft" />
    </TelosChatRouteLayout>
  );
}
function SourceChat() {
  const location = useLocation();
  const { id } = useParams();
  const query = new URLSearchParams(location.search);
  return (
    <TelosSourceNavigationProvider
      sessionId={id!}
      request={{
        itemId: query.get('telosItem')!,
        snapshotId: query.get('telosSource')!,
        conversationId: id!,
      }}
    >
      <output data-testid="source-url">{location.pathname + location.search}</output>
      <Chat />
    </TelosSourceNavigationProvider>
  );
}
it.each([false, true])(
  'adopts Materials readSourceHref without changing its selector, other bound role=%s',
  async (boundElsewhere) => {
    const links = ['slice', 'other'].map((itemId) => ({
      version: 1,
      linkId: itemId,
      itemId,
      role: 'origin',
      conversation: { namespace: 'mitzo', conversationId: 'planning' },
      availability: 'available',
      linkedAt: null,
      linkedBy: null,
      attemptId: null,
    }));
    vi.spyOn(TelosWorkApiClient.prototype, 'links').mockResolvedValue(links as never);
    vi.spyOn(TelosWorkApiClient.prototype, 'read').mockImplementation(
      async (itemId) =>
        ({
          itemId,
          kind: 'work_item',
          parentId: null,
          revision: 'a'.repeat(64),
          links: links.filter((link) => link.itemId === itemId),
          sources: itemId === 'slice' ? [snapshot] : [],
          attempts: [],
          assignments: [],
        }) as never,
    );
    vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(
      async (itemId) =>
        ({
          itemId,
          summary: itemId === 'slice' ? 'Planning source item' : 'Other worker item',
        }) as never,
    );
    vi.spyOn(TelosWorkApiClient.prototype, 'readSource').mockResolvedValue({
      available: true,
      sourceHref: '/chat/planning?telosItem=slice&telosSource=reviewed-exchange',
      snapshot,
      packet: { context: { sourceConversationId: 'planning' } },
    } as never);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({
            sessionId: 'planning',
            ...(boundElsewhere ? { telosWorkRoleContext: { itemId: 'other' } } : {}),
          }),
        }),
    );
    render(
      <MitzoStoreProvider value={createTestStore()}>
        <MemoryRouter initialEntries={['/todos/slice?view=Materials']}>
          <Routes>
            <Route
              path="/todos/slice"
              element={
                <TelosItemSources itemId="slice" legacySources={[]} onOpenExternal={() => {}} />
              }
            />
            <Route path="/chat/:id" element={<SourceChat />} />
          </Routes>
        </MemoryRouter>
      </MitzoStoreProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open original chat' }));
    await screen.findByRole('button', { name: 'View item: Planning source item' });
    expect(screen.getByRole('link', { name: 'Back' }).getAttribute('href')).toBe(
      '/todos/slice?view=Chat&chooseChat=1',
    );
    expect(screen.getByTestId('source-url').textContent).toBe(
      '/chat/planning?telosItem=slice&telosSource=reviewed-exchange',
    );
    expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement).value).toBe(
      'Planning draft',
    );
  },
);

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { TelosWorkApiClient } from '@mitzo/client';
import { TelosWorkViewSchema, TelosWorkItemSchema } from '@mitzo/protocol';
import { createTestStore } from '../../test-utils/createTestStore';
import { useTelosChatRoute } from '../../hooks/useTelosChatRoute';
import { TelosChatRouteLayout } from '../TelosChatRouteLayout';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const link = {
  version: 1,
  linkId: 'link',
  itemId: 'slice',
  role: 'worker',
  conversation: { namespace: 'mitzo', conversationId: 'worker' },
  availability: 'available',
  linkedAt: null,
  linkedBy: null,
  attemptId: null,
};
const record = TelosWorkItemSchema.parse({
  version: 1,
  itemId: 'slice',
  kind: 'work_item',
  parentId: 'goal',
  summary: 'Recording plan',
  intent: 'Plan',
  rationale: '',
  acceptanceCriteria: [],
  profile: 'manual',
  status: 'active',
  starred: false,
  priority: 7,
  categories: [],
  createdAt: null,
  updatedAt: null,
  contextHints: {
    repos: [],
    paths: [],
    issues: [],
    docIds: [],
    people: [],
    jiraKeys: [],
    keywords: [],
    taskHint: '',
    sessionIds: [],
  },
  sources: [],
  links: [],
  legacyFields: {},
});
function Harness() {
  const route = useTelosChatRoute('worker');
  return (
    <TelosChatRouteLayout
      route={route}
      conversationId="worker"
      header={<header>Ordinary settings</header>}
    >
      <textarea aria-label="Draft" defaultValue="Unsent" />
    </TelosChatRouteLayout>
  );
}
function mount(query = '?telosChatItem=slice', linked = true) {
  vi.spyOn(TelosWorkApiClient.prototype, 'links').mockResolvedValue(linked ? [link as never] : []);
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue(
    TelosWorkViewSchema.parse({
      itemId: 'slice',
      kind: 'work_item',
      parentId: 'goal',
      revision: 'a'.repeat(64),
      links: [link],
      sources: [],
      attempts: [],
      assignments: [],
    }),
  );
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockResolvedValue(record);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sessionId: 'worker' }) }),
  );
  const store = createTestStore();
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter initialEntries={['/chat/worker' + query]}>
        <Harness />
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  return store;
}
it('adopts one compact item/chats/work row around the existing ordinary controls and composer', async () => {
  mount();
  const input = screen.getByRole('textbox', { name: 'Draft' });
  fireEvent.change(input, { target: { value: 'Independent draft' } });
  await screen.findByRole('button', { name: 'View item: Recording plan' });
  expect(screen.getByText('Ordinary settings')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(input);
  expect((input as HTMLTextAreaElement).value).toBe('Independent draft');
  expect(screen.getByRole('button', { name: 'Chats for this item: 1' })).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Toggle work tree' }).getAttribute('aria-expanded'),
  ).toBe('false');
});
it('does not attach an unrelated explicit item to an ordinary conversation', async () => {
  mount('?telosChatItem=unrelated');
  await screen.findByRole('status');
  expect(screen.queryByRole('button', { name: /View item:/ })).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBeTruthy();
});
it('rechecks current work and canonical record projections after transport reconnect without remounting the composer', async () => {
  const store = mount();
  await screen.findByRole('button', { name: 'View item: Recording plan' });
  const input = screen.getByRole('textbox', { name: 'Draft' });
  fireEvent.change(input, { target: { value: 'Reconnect draft' } });
  const current = await TelosWorkApiClient.prototype.read('slice');
  vi.mocked(TelosWorkApiClient.prototype.read).mockResolvedValue({
    ...current,
    links: [
      ...current.links,
      {
        ...current.links[0],
        linkId: 'review',
        role: 'reviewer',
        conversation: { namespace: 'mitzo', conversationId: 'reviewer' },
      },
    ],
  });
  vi.mocked(TelosWorkApiClient.prototype.readRecord).mockResolvedValue({
    ...record,
    summary: 'Updated recording plan',
    priority: 9,
  });
  act(() => store.setState((s) => ({ connection: { ...s.connection, status: 'connected' } })));
  await screen.findByRole('button', { name: 'Chats for this item: 2' });
  await screen.findByRole('button', { name: 'View item: Updated recording plan' });
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(input);
  expect((input as HTMLTextAreaElement).value).toBe('Reconnect draft');
});

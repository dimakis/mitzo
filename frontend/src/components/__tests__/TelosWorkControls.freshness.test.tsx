// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { TelosWorkApiClient } from '@mitzo/client';
import type { TelosWorkControlView, TelosWorkView } from '@mitzo/protocol';
import { createTestStore } from '../../test-utils/createTestStore';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import { useTelosChatWork } from '../../hooks/useTelosChatWork';
import { useTelosChatRoute } from '../../hooks/useTelosChatRoute';
import { TelosChatFrame } from '../TelosChatFrame';
import { TelosWorkControls } from '../TelosWorkControls';
const events = vi.hoisted(() => ({
  updates: new Set<() => void>(),
  connected: new Set<(connected: boolean) => void>(),
}));
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: (event: string, listener: () => void) => {
      if (event === 'todo_update') events.updates.add(listener);
      return () => events.updates.delete(listener);
    },
    onConnectionChange: (listener: (connected: boolean) => void) => {
      events.connected.add(listener);
      return () => events.connected.delete(listener);
    },
  },
}));
const source = createTelosWorkFixtures().homeStudio.items[0];
const coordinator = {
  ...source,
  itemId: 'coordinator',
  parentId: null,
  kind: 'coordinator' as const,
  summary: 'Programme',
};
const outcomes = [0, 1].map((i) => ({
  ...source,
  itemId: `outcome-${i}`,
  parentId: 'coordinator',
  summary: `Feature ${i}`,
}));
const records = [coordinator, ...outcomes];
vi.mock('../../hooks/useTodoData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useTodoData')>()),
  useTodoData: () => ({
    items: [
      {
        id: 'coordinator',
        children: [
          { id: 'outcome-0', children: [] },
          { id: 'outcome-1', children: [] },
        ],
      },
    ],
    loading: false,
    refreshing: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
const link = {
  version: 1 as const,
  linkId: 'old-link',
  itemId: 'coordinator',
  role: 'lead' as const,
  conversation: { namespace: 'mitzo' as const, conversationId: 'old-lead' },
  availability: 'available' as const,
  linkedAt: null,
  linkedBy: null,
  attemptId: null,
};
const work = (conversationId = 'old-lead'): TelosWorkView => ({
  itemId: 'coordinator',
  kind: 'coordinator',
  parentId: null,
  revision: 'a'.repeat(64),
  sources: [],
  attempts: [],
  links: [link],
  assignments: [
    {
      itemId: 'coordinator',
      role: 'lead',
      conversation: { namespace: 'mitzo', conversationId },
      revision: conversationId === 'old-lead' ? 1 : 2,
      assignedAt: null,
      assignedBy: null,
    },
  ],
});
const receipt: TelosWorkControlView = {
  version: 1,
  controlId: 'control',
  coordinatorItemId: 'coordinator',
  coordinatorConversationId: 'old-lead',
  priorityItemId: 'outcome-0',
  scope: 'new_worker_dispatch',
  stage: 'requested',
  publicationRevalidation: 'not_applicable',
  targets: [
    {
      itemId: 'outcome-1',
      leadConversationId: 'other',
      assignmentRevision: 1,
      stage: 'requested',
      workers: [],
    },
  ],
  history: [],
};
const command = {
  operation: 'request' as const,
  requestId: '16f71791-20b5-4461-b2ec-e4dcbfd457ae',
  coordinatorItemId: 'coordinator',
  priorityItemId: 'outcome-0',
  targetItemIds: ['outcome-1'],
  scope: 'new_worker_dispatch' as const,
};
const storageKey = 'telos.control.pending.coordinator';
function Harness() {
  const route = useTelosChatRoute('old-lead');
  return (
    <TelosChatFrame
      conversationId="old-lead"
      itemTitle="Programme"
      chatCount={1}
      onItem={vi.fn()}
      onChats={vi.fn()}
      header={<header>Ordinary controls</header>}
      tree={<p>Retained work tree</p>}
    >
      <textarea aria-label="Draft" defaultValue="Retain this draft" />
      <TelosWorkControls data={route.data} conversationId="old-lead" />
    </TelosChatFrame>
  );
}
beforeEach(() => {
  sessionStorage.clear();
  events.updates.clear();
  events.connected.clear();
  vi.spyOn(TelosWorkApiClient.prototype, 'links').mockResolvedValue([link]);
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async (id) =>
    records.find((value) => value.itemId === id)!,
  );
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sessionId: 'old-lead' }) }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount() {
  render(
    <MitzoStoreProvider value={createTestStore()}>
      <MemoryRouter initialEntries={['/chat/old-lead?telosChatItem=coordinator']}>
        <Harness />
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
}
for (const event of ['todo_update', 'reconnect'] as const)
  for (const action of ['request', 'release', 'retry'] as const) {
    it(`fences ${action} while ${event} replacement work is held, preserving receipts, draft and original retry identity`, async () => {
      let hold = false;
      const waiting: Array<(value: TelosWorkView) => void> = [];
      vi.spyOn(TelosWorkApiClient.prototype, 'read').mockImplementation(() =>
        hold ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve(work()),
      );
      const controls = vi
        .spyOn(TelosWorkApiClient.prototype, 'control')
        .mockImplementation(async (input) =>
          input.operation === 'inbox' ? (action === 'release' ? [receipt] : []) : receipt,
        );
      if (action === 'retry')
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ version: 1, itemId: 'coordinator', command }),
        );
      mount();
      if (action === 'request') {
        await screen.findByRole('button', { name: 'Feature 0' });
        fireEvent.click(screen.getByRole('button', { name: 'Feature 0' }));
      }
      const button = await screen.findByRole('button', {
        name:
          action === 'request'
            ? 'Send hold to one lead'
            : action === 'release'
              ? 'Release held leads'
              : 'Retry original request',
      });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
      const draft = screen.getByRole('textbox', { name: 'Draft' });
      draft.focus();
      const retained = sessionStorage.getItem(storageKey);
      hold = true;
      act(() => {
        if (event === 'todo_update') events.updates.forEach((listener) => listener());
        else events.connected.forEach((listener) => listener(true));
      });
      await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      await waitFor(() =>
        expect(
          controls.mock.calls.filter(([value]) => value.operation === 'inbox').length,
        ).toBeGreaterThan(1),
      );
      if (action === 'release') {
        fireEvent.click(screen.getByRole('button', { name: 'Check acknowledgements' }));
        await waitFor(() =>
          expect(controls.mock.calls.some(([value]) => value.operation === 'read')).toBe(true),
        );
      }
      expect(screen.getByRole('button', { name: button.textContent! })).toBe(button);
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
      expect(
        controls.mock.calls.every(([value]) => ['inbox', 'read'].includes(value.operation)),
      ).toBe(true);
      expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft);
      expect((draft as HTMLTextAreaElement).value).toBe('Retain this draft');
      expect(document.activeElement).toBe(draft);
      expect(sessionStorage.getItem(storageKey)).toBe(retained);
      await act(async () => waiting.splice(0).forEach((resolve) => resolve(work())));
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
      expect(screen.getByRole('button', { name: button.textContent! })).toBe(button);
      expect(sessionStorage.getItem(storageKey)).toBe(retained);
      act(() => {
        if (event === 'todo_update') events.updates.forEach((listener) => listener());
        else events.connected.forEach((listener) => listener(true));
      });
      await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      expect((button as HTMLButtonElement).disabled).toBe(true);
      await act(async () => waiting.forEach((resolve) => resolve(work('replacement-lead'))));
      await waitFor(() =>
        expect(screen.queryByRole('region', { name: 'Coordinator controls' })).toBeNull(),
      );
      expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft);
      expect(document.activeElement).toBe(draft);
      expect(sessionStorage.getItem(storageKey)).toBe(retained);
      expect(
        controls.mock.calls.every(([value]) => ['inbox', 'read'].includes(value.operation)),
      ).toBe(true);
    });
  }

it('keeps a retained work view display-only when returning to the same item starts a new read', async () => {
  let release!: (value: TelosWorkView) => void;
  vi.spyOn(TelosWorkApiClient.prototype, 'read')
    .mockResolvedValueOnce(work())
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
  const { result, rerender } = renderHook(
    ({ id }: { id: string | null }) => useTelosChatWork(id, 0),
    { initialProps: { id: 'coordinator' as string | null } },
  );
  await waitFor(() => expect(result.current.current).toBe(true));
  const original = result.current.work;
  rerender({ id: null });
  expect(result.current.current).toBe(false);
  rerender({ id: 'coordinator' });
  expect(result.current.work).toBe(original);
  expect(result.current.current).toBe(false);
  await act(async () => release(work()));
  expect(result.current.current).toBe(true);
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { TelosWorkApiClient } from '@mitzo/client';
import { TelosWorkViewSchema, type TelosWorkItem } from '@mitzo/protocol';
import { TodoDetailView } from '../TodoDetailView';
import { useTodoData } from '../../hooks/useTodoData';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
const updates = vi.hoisted(() => new Set<() => void>());
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: (event: string, listener: () => void) => {
      if (event === 'todo_update') updates.add(listener);
      return () => updates.delete(listener);
    },
    onConnectionChange: () => () => {},
  },
}));

vi.mock('../../hooks/useTodoData', async (original) => ({
  ...(await original<object>()),
  useTodoData: vi.fn(),
}));
vi.mock('../../hooks/useStageChatLaunch', () => ({ useStageChatLaunch: () => vi.fn() }));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: { newSession: () => void }) => unknown) =>
    select({ newSession: vi.fn() }),
}));
vi.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => ({
    sessions: [
      { id: 'origin', summary: 'Original planning' },
      { id: 'lead-a', summary: 'First lead' },
      { id: 'lead-b', summary: 'Replacement lead' },
    ],
  }),
}));
vi.mock('../../lib/api-fetch', async (original) => ({
  ...(await original<object>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ sessionId: 'origin' }))),
}));
const root = {
  ...createTelosWorkFixtures().homeStudio.items[0],
  itemId: 'studio',
  parentId: 'parent',
  priority: 5,
};
const parent = {
  ...root,
  itemId: 'parent',
  parentId: null,
  kind: 'coordinator' as const,
  summary: 'Recording programme',
};
const item = {
  id: 'studio',
  summary: root.summary,
  profile: 'manual',
  urgency: 0.5,
  priority: 5,
  starred: false,
  status: 'active' as const,
  ageDays: 0,
  parentId: 'parent',
  children: [],
  childCount: 0,
  completedChildCount: 0,
  sources: [],
  goalId: null,
  contextHints: root.contextHints,
};
const collection = (items: (typeof item)[] = []) => ({
  items,
  loading: items.length === 0,
  refreshing: false,
  refreshKey: 0,
  error: null,
  profiles: [],
  refresh: vi.fn(),
  setPriority: vi.fn(),
  ack: vi.fn(),
  snooze: vi.fn(),
  done: vi.fn(),
  star: vi.fn(),
  createOutcome: vi.fn(),
  create: vi.fn(),
});
function work(id = 'studio', assigned = 'lead-a') {
  return TelosWorkViewSchema.parse({
    itemId: id,
    kind: 'outcome',
    parentId: null,
    revision: 'a'.repeat(64),
    sources: [],
    attempts: [],
    links: ['origin', 'lead-a', 'lead-b'].map((conversationId) => ({
      version: 1,
      linkId: conversationId,
      itemId: id,
      role: conversationId === 'origin' ? 'origin' : 'lead',
      conversation: { namespace: 'mitzo', conversationId },
      linkedAt: null,
      linkedBy: null,
      availability: 'available',
      attemptId: null,
    })),
    assignments: [
      {
        itemId: id,
        role: 'lead',
        conversation: { namespace: 'mitzo', conversationId: assigned },
        revision: assigned === 'lead-a' ? 1 : 2,
        assignedAt: null,
        assignedBy: null,
      },
    ],
    assignmentHistory: {
      lead: { complete: true, conversationIds: ['lead-a', assigned] },
      worker: { complete: true, conversationIds: [] },
    },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function Navigation() {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate('/todos/other?view=Chat&chooseChat=1')}>Different item</button>
  );
}
function mount() {
  return render(
    <MemoryRouter initialEntries={['/todos/studio?view=Chat&chooseChat=1']}>
      <Navigation />
      <Routes>
        <Route path="/todos/:id" element={<TodoDetailView />} />
        <Route path="/todos" element={<p>Collection</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.mocked(useTodoData).mockReturnValue(collection() as ReturnType<typeof useTodoData>);
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockImplementation(async (id) => work(id));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('keeps the exact chooser/provenance/focus mounted while late collection discovery expands related reads, then accepts newer record and assignment ownership', async () => {
  const related = deferred<TelosWorkItem>();
  let discovered = false;
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async (id) =>
    id === 'parent'
      ? related.promise
      : discovered
        ? { ...root, summary: 'Updated studio', priority: 8 }
        : root,
  );
  const view = mount();
  await screen.findByRole('button', { name: 'Open Originating conversation: Original planning' });
  const summary = screen.getAllByText('Conversation provenance')[0].closest('summary')!;
  const workspace = summary.closest('.telos-item-workspace');
  fireEvent.click(summary);
  summary.focus();
  expect(summary.closest('details')!.open).toBe(true);
  discovered = true;
  vi.mocked(TelosWorkApiClient.prototype.read).mockImplementation(async (id) => work(id, 'lead-b'));
  vi.mocked(useTodoData).mockReturnValue(collection([item]) as ReturnType<typeof useTodoData>);
  view.rerender(
    <MemoryRouter initialEntries={['/todos/studio?view=Chat&chooseChat=1']}>
      <Navigation />
      <Routes>
        <Route path="/todos/:id" element={<TodoDetailView />} />
        <Route path="/todos" element={<p>Collection</p>} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(TelosWorkApiClient.prototype.readRecord).toHaveBeenCalledWith(
      'parent',
      expect.any(AbortSignal),
    ),
  );
  expect(summary.isConnected).toBe(true);
  expect(document.activeElement).toBe(summary);
  expect(summary.closest('details')!.open).toBe(true);
  await act(async () => related.resolve(parent));
  await screen.findByRole('button', { name: 'Recording programme' });
  await act(async () => {
    for (const update of updates) update();
  });
  await screen.findByRole('heading', { name: 'Updated studio' });
  expect(screen.getByRole('heading', { name: 'Updated studio' })).toBeTruthy();
  expect(summary.closest('.telos-item-workspace')).toBe(workspace);
  expect(summary.isConnected).toBe(true);
  expect(document.activeElement).toBe(summary);
  expect(summary.closest('details')!.open).toBe(true);
  await screen.findByRole('button', { name: 'Open Assigned lead: Replacement lead' });
  expect((screen.getByRole('combobox', { name: 'Priority' }) as HTMLSelectElement).value).toBe('8');
});
it('does not carry the previous item workspace into a real navigation or let an aborted old related read replace newer ownership', async () => {
  const related = deferred<TelosWorkItem>(),
    other = deferred<TelosWorkItem>(),
    stalePrimary = deferred<TelosWorkItem>();
  let firstPrimary = true;
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async (id) => {
    if (id === 'studio') {
      if (firstPrimary) {
        firstPrimary = false;
        return root;
      }
      return stalePrimary.promise;
    }
    return id === 'parent' ? related.promise : other.promise;
  });
  const view = mount();
  const opener = await screen.findByRole('button', {
    name: 'Open Originating conversation: Original planning',
  });
  vi.mocked(useTodoData).mockReturnValue(collection([item]) as ReturnType<typeof useTodoData>);
  view.rerender(
    <MemoryRouter initialEntries={['/todos/studio?view=Chat&chooseChat=1']}>
      <Navigation />
      <Routes>
        <Route path="/todos/:id" element={<TodoDetailView />} />
        <Route path="/todos" element={<p>Collection</p>} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(TelosWorkApiClient.prototype.readRecord).toHaveBeenCalledWith(
      'parent',
      expect.any(AbortSignal),
    ),
  );
  await act(async () => {
    for (const update of updates) update();
  });
  fireEvent.click(screen.getByRole('button', { name: 'Different item' }));
  expect(opener.isConnected).toBe(false);
  expect(screen.queryByRole('heading', { name: root.summary })).toBeNull();
  await act(async () => {
    related.resolve(parent);
    stalePrimary.resolve({ ...root, summary: 'Late stale primary' });
  });
  expect(screen.queryByRole('heading', { name: parent.summary })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Late stale primary' })).toBeNull();
  await act(async () =>
    other.resolve({ ...root, itemId: 'other', parentId: null, summary: 'Other current owner' }),
  );
  await screen.findByRole('heading', { name: 'Other current owner' });
  expect(screen.queryByRole('heading', { name: root.summary })).toBeNull();
});
it('keeps the chooser through related failure, retries both read owners, and accepts visible-resume refresh without remounting', async () => {
  let failRelated = true,
    resumed = false;
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async (id) => {
    if (id === 'parent') {
      if (failRelated) throw Error('Parent unavailable');
      return parent;
    }
    return resumed ? { ...root, summary: 'Fresh after resume' } : root;
  });
  const view = mount();
  await screen.findByRole('button', { name: 'Open Originating conversation: Original planning' });
  const summary = screen.getAllByText('Conversation provenance')[0].closest('summary')!;
  fireEvent.click(summary);
  summary.focus();
  vi.mocked(useTodoData).mockReturnValue(collection([item]) as ReturnType<typeof useTodoData>);
  view.rerender(
    <MemoryRouter initialEntries={['/todos/studio?view=Chat&chooseChat=1']}>
      <Navigation />
      <Routes>
        <Route path="/todos/:id" element={<TodoDetailView />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText(/Some related outcome records are unavailable/);
  expect(summary.isConnected).toBe(true);
  expect(document.activeElement).toBe(summary);
  expect(summary.closest('details')!.open).toBe(true);
  failRelated = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByRole('button', { name: 'Recording programme' });
  expect(summary.isConnected).toBe(true);
  expect(summary.closest('details')!.open).toBe(true);
  resumed = true;
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await screen.findByRole('heading', { name: 'Fresh after resume' });
  expect(summary.isConnected).toBe(true);
  expect(summary.closest('details')!.open).toBe(true);
});
it('releases a retained canonical workspace after the current record read settles unavailable', async () => {
  const related = deferred<TelosWorkItem>();
  let discovered = false;
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async (id) => {
    if (discovered && id === 'studio') throw Error('Unavailable');
    return id === 'parent' ? related.promise : root;
  });
  const view = mount();
  await screen.findByRole('button', { name: 'Open Originating conversation: Original planning' });
  discovered = true;
  vi.mocked(useTodoData).mockReturnValue(collection([item]) as ReturnType<typeof useTodoData>);
  view.rerender(
    <MemoryRouter initialEntries={['/todos/studio?view=Chat&chooseChat=1']}>
      <Navigation />
      <Routes>
        <Route path="/todos/:id" element={<TodoDetailView />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {
    for (const update of updates) update();
  });
  await act(async () => related.resolve(parent));
  await waitFor(() => expect(document.querySelector('.telos-item-workspace')).toBeNull());
});

it('keeps no-snapshot navigation in a standard loading frame until the canonical primary read settles', async () => {
  const pending = deferred<TelosWorkItem>();
  vi.mocked(useTodoData).mockReturnValue(collection() as ReturnType<typeof useTodoData>);
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation((id) =>
    id === 'studio' ? pending.promise : Promise.resolve(parent),
  );
  const view = mount();
  expect(view.container.querySelector('.todo-detail-legacy')).toBeNull();
  expect(screen.getByText('Loading item…').getAttribute('role')).toBe('status');
  expect(screen.queryByText('Urgency')).toBeNull();
  await act(async () => pending.resolve(root));
  await screen.findByRole('heading', { name: root.summary });
  expect(view.container.querySelector('.telos-item-workspace')).toBeTruthy();
});

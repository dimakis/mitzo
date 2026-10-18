// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TelosWorkApiClient } from '@mitzo/client';
import type { TelosWorkItem, TelosWorkView } from '@mitzo/protocol';
import type { TodoItem } from '../../types/todo';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import { TodoView } from '../../pages/TodoView';

const { updates, collection } = vi.hoisted(() => ({
  updates: new Set<() => void>(),
  collection: vi.fn(),
}));
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: (event: string, listener: () => void) => {
      if (event === 'todo_update') updates.add(listener);
      return () => updates.delete(listener);
    },
  },
}));
vi.mock('../../hooks/useTodoData', () => ({ useTodoData: collection }));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: Record<string, unknown>) => unknown) =>
    select({ newSession: vi.fn(), setPendingSession: vi.fn() }),
}));

const fixture = createTelosWorkFixtures().leadWithUnstartedSlice;
let record: TelosWorkItem;
function work(kind: TelosWorkView['kind'] = 'outcome', assigned = false): TelosWorkView {
  return {
    itemId: record.itemId,
    kind,
    parentId: null,
    revision: 'f'.repeat(64),
    links: [],
    assignments:
      assigned && (kind === 'outcome' || kind === 'work_item')
        ? [{ ...fixture.assignments[0], role: kind === 'outcome' ? 'lead' : 'worker' }]
        : [],
    sources: [],
    attempts: [],
  };
}
function mount() {
  return render(
    <MemoryRouter>
      <TodoView />
    </MemoryRouter>,
  );
}
function row() {
  return screen.getByRole('button', { name: record.summary }).closest('li');
}
function refresh() {
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Telos' }));
}
function update() {
  act(() => updates.forEach((listener) => listener()));
}
beforeEach(() => {
  localStorage.clear();
  record = { ...fixture.items[0], parentId: null };
  const item: TodoItem = {
    id: record.itemId,
    summary: record.summary,
    profile: record.profile,
    urgency: 1,
    priority: 5,
    starred: false,
    status: 'active',
    ageDays: 0,
    parentId: null,
    children: [],
    childCount: 0,
    completedChildCount: 0,
    sources: [],
    links: [],
    contextHints: record.contextHints,
    goalId: null,
  };
  collection.mockReturnValue({
    loading: false,
    items: [item],
    profiles: ['manual'],
    refresh: vi.fn(),
  });
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async () =>
    structuredClone(record),
  );
});
afterEach(() => {
  cleanup();
  expect(updates.size).toBe(0);
  vi.restoreAllMocks();
  collection.mockReset();
});

it('recovers a failed conversation read through the actual Refresh Telos action without remounting the row', async () => {
  const read = vi
    .spyOn(TelosWorkApiClient.prototype, 'read')
    .mockRejectedValueOnce(Error('temporary failure'))
    .mockResolvedValueOnce(work('outcome', true));
  mount();
  await screen.findByText('Conversations unavailable');
  const mounted = row();
  refresh();
  await screen.findByRole('button', { name: 'Lead chat' });
  expect(row()).toBe(mounted);
  expect(collection().refresh).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Conversations unavailable')).toBeNull();
});

it('updates authoritative assignment and kind controls for the same mounted item on item events', async () => {
  let current = work();
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockImplementation(async () =>
    structuredClone(current),
  );
  mount();
  await screen.findByRole('button', { name: 'Choose lead' });
  const mounted = row();
  current = work('outcome', true);
  update();
  await screen.findByRole('button', { name: 'Lead chat' });
  record = { ...record, kind: 'work_item' };
  current = work('work_item', true);
  update();
  await screen.findByRole('button', { name: 'Worker chat' });
  expect(screen.queryByRole('button', { name: 'Lead chat' })).toBeNull();
  record = { ...record, kind: 'coordinator' };
  current = work('coordinator');
  update();
  await screen.findByRole('button', { name: 'View coordinator' });
  record = { ...record, kind: null };
  current = work(null);
  update();
  await screen.findByText('Role unclassified');
  expect(screen.queryByRole('button', { name: 'View coordinator' })).toBeNull();
  expect(row()).toBe(mounted);
});

it.each(['item event', 'visible resume'])(
  'recovers on %s, ignores hidden visibility changes, and cleans up mounted subscriptions',
  async (source) => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const read = vi
      .spyOn(TelosWorkApiClient.prototype, 'read')
      .mockRejectedValueOnce(Error('temporary failure'))
      .mockResolvedValue(work('outcome', true));
    const mounted = mount();
    await screen.findByText('Conversations unavailable');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(read).toHaveBeenCalledOnce();
    visibility.mockReturnValue('visible');
    if (source === 'item event') update();
    else act(() => document.dispatchEvent(new Event('visibilitychange')));
    await screen.findByRole('button', { name: 'Lead chat' });
    expect(read).toHaveBeenCalledTimes(2);
    mounted.unmount();
    update();
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(read).toHaveBeenCalledTimes(2);
  },
);

it.each(['success', 'failure'] as const)(
  'ignores a superseded same-item %s even when the transport ignores abort',
  async (outcome) => {
    let release!: (view: TelosWorkView) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<TelosWorkView>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    let signal: AbortSignal | undefined;
    const old = work();
    const read = vi
      .spyOn(TelosWorkApiClient.prototype, 'read')
      .mockResolvedValueOnce(old)
      .mockImplementationOnce((_id, abort) => {
        signal = abort;
        return pending;
      })
      .mockResolvedValueOnce(work('work_item', true));
    mount();
    await screen.findByRole('button', { name: 'Choose lead' });
    const mounted = row();
    refresh();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    record = { ...record, kind: 'work_item' };
    refresh();
    await screen.findByRole('button', { name: 'Worker chat' });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      if (outcome === 'success') release(old);
      else reject(Error('superseded failure'));
      await pending.catch(() => undefined);
    });
    expect(screen.getByRole('button', { name: 'Worker chat' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose lead' })).toBeNull();
    expect(screen.queryByText('Conversations unavailable')).toBeNull();
    expect(row()).toBe(mounted);
  },
);

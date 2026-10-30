// @vitest-environment jsdom
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TelosWorkApiClient } from '@mitzo/client';
import type { TelosWorkItem, TelosWorkView } from '@mitzo/protocol';
import type { TodoItem } from '../../types/todo';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import { TodoWorkspace } from '../../pages/TodoWorkspace';

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
    onConnectionChange: () => () => {},
  },
}));
vi.mock('../../hooks/useTodoData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useTodoData')>()),
  useTodoData: function useFixtureData(...args: unknown[]) {
    const data = collection(...args);
    const [refreshKey, setRefreshKey] = useState(0);
    useEffect(() => {
      const refresh = () => setRefreshKey((key) => key + 1);
      const resume = () => {
        if (document.visibilityState === 'visible') refresh();
      };
      updates.add(refresh);
      document.addEventListener('visibilitychange', resume);
      return () => {
        updates.delete(refresh);
        document.removeEventListener('visibilitychange', resume);
      };
    }, []);
    // The native collection owns both records and refresh invalidation.
    return {
      ...data,
      records: [record, ...(childRecord ? [childRecord] : [])],
      refreshKey,
      refresh: () => {
        data.refresh();
        setRefreshKey((key) => key + 1);
      },
    };
  },
}));
vi.mock('../TelosItemRoleEntries', () => ({ TelosItemRoleEntries: () => null }));
vi.mock('../TelosItemSources', () => ({ TelosItemSources: () => null }));
vi.mock('../WorkOutputs', () => ({ WorkOutputs: () => null }));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: Record<string, unknown>) => unknown) =>
    select({ newSession: vi.fn(), setPendingSession: vi.fn() }),
}));

const fixture = createTelosWorkFixtures().leadWithUnstartedSlice;
let record: TelosWorkItem;
let childRecord: TelosWorkItem | undefined;
let subscriptionBaseline: number;
function work(
  kind: TelosWorkView['kind'] = 'outcome',
  assigned = false,
  itemId = record.itemId,
): TelosWorkView {
  return {
    itemId,
    kind,
    parentId: itemId === childRecord?.itemId ? record.itemId : null,
    revision: 'f'.repeat(64),
    links: [],
    assignments:
      assigned && (kind === 'outcome' || kind === 'work_item')
        ? [{ ...fixture.assignments[0], itemId, role: kind === 'outcome' ? 'lead' : 'worker' }]
        : [],
    sources: [],
    attempts: [],
  };
}
function mount(path = '/todos') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/todos/:id?" element={<TodoWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );
}
function row(summary = record.summary) {
  return screen.getByRole('button', { name: summary }).closest('li');
}
function refresh() {
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Telos' }));
}
function update() {
  act(() => updates.forEach((listener) => listener()));
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  subscriptionBaseline = updates.size;
  childRecord = undefined;
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
  const readRecord = async (id: string) => {
    const found = [record, childRecord].find((value) => value?.itemId === id);
    if (!found) throw Error('Unknown test record');
    return structuredClone(found);
  };
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(readRecord);
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecords').mockImplementation(async (ids) => ({
    records: await Promise.all(ids.map(readRecord)),
    failures: [],
  }));
});
afterEach(() => {
  cleanup();
  expect(updates.size).toBe(subscriptionBaseline);
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
  // A native refresh does not speculatively refresh the disabled legacy owner.
  expect(collection().refresh).toHaveBeenCalledTimes(1);
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
  await screen.findByRole('button', { name: 'Open chats' });
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

function mountChild(tab: 'Overview' | 'Work') {
  childRecord = { ...fixture.items[1], parentId: record.itemId };
  const parent = collection().items[0] as TodoItem;
  parent.children = [
    {
      ...parent,
      id: childRecord.itemId,
      summary: childRecord.summary,
      parentId: record.itemId,
      children: [],
      childCount: 0,
    },
  ];
  parent.childCount = 1;
  sessionStorage.setItem('telos.item.tab.' + record.itemId, tab);
  return childRecord;
}

it.each([
  ['Overview', 'item event'],
  ['Overview', 'visible resume'],
  ['Work', 'item event'],
  ['Work', 'visible resume'],
] as const)(
  'recovers the same mounted child in %s through %s and refreshes assignment/kind',
  async (tab, source) => {
    const child = mountChild(tab);
    let current = work('work_item', false, child.itemId);
    vi.spyOn(TelosWorkApiClient.prototype, 'read')
      .mockRejectedValueOnce(Error('temporary child failure'))
      .mockImplementation(async () => structuredClone(current));
    mount('/todos/' + record.itemId);
    await screen.findByText('Conversations unavailable');
    const mounted = row(child.summary);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    if (source === 'item event') update();
    else act(() => document.dispatchEvent(new Event('visibilitychange')));
    await screen.findByRole('button', { name: 'Choose worker' });
    current = work('work_item', true, child.itemId);
    update();
    await screen.findByRole('button', { name: 'Worker chat' });
    childRecord = { ...child, kind: 'outcome' };
    current = work('outcome', true, child.itemId);
    update();
    await screen.findByRole('button', { name: 'Lead chat' });
    expect(screen.queryByRole('button', { name: 'Worker chat' })).toBeNull();
    childRecord = { ...child, kind: 'coordinator' };
    current = work('coordinator', false, child.itemId);
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await screen.findByRole('button', { name: 'View coordinator' });
    childRecord = { ...child, kind: null };
    current = work(null, false, child.itemId);
    update();
    await screen.findByRole('button', { name: 'Open chats' });
    expect(row(child.summary)).toBe(mounted);
    expect(
      screen.getByRole('button', { name: tab, pressed: true }).getAttribute('aria-pressed'),
    ).toBe('true');
  },
);

it.each([
  ['Overview', 'success'],
  ['Overview', 'failure'],
  ['Work', 'success'],
  ['Work', 'failure'],
] as const)('keeps the newest mounted child in %s after superseded %s', async (tab, outcome) => {
  const child = mountChild(tab);
  const old = work('work_item', false, child.itemId);
  let resolve!: (value: TelosWorkView) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<TelosWorkView>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let signal: AbortSignal | undefined;
  const read = vi
    .spyOn(TelosWorkApiClient.prototype, 'read')
    .mockResolvedValueOnce(old)
    .mockImplementationOnce((_id, abort) => {
      signal = abort;
      return pending;
    })
    .mockResolvedValue(work('work_item', true, child.itemId));
  mount('/todos/' + record.itemId);
  await screen.findByRole('button', { name: 'Choose worker' });
  const mounted = row(child.summary);
  update();
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await screen.findByRole('button', { name: 'Worker chat' });
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    if (outcome === 'success') resolve(old);
    else reject(Error('superseded child failure'));
    await pending.catch(() => undefined);
  });
  expect(screen.getByRole('button', { name: 'Worker chat' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Choose worker' })).toBeNull();
  expect(screen.queryByText('Conversations unavailable')).toBeNull();
  expect(row(child.summary)).toBe(mounted);
});

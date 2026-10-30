import { canonicalTodoData } from '../../lib/canonical-todo-data';
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { TodoWorkspace } from '../TodoWorkspace';
import { markAuthLost } from '../../lib/api-fetch';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: object) => unknown) =>
    select({ newSession: vi.fn(), setPendingSession: vi.fn() }),
}));
vi.mock('../../components/TelosItemRoleEntries', () => ({ TelosItemRoleEntries: () => null }));
vi.mock('../../components/TelosItemSources', () => ({ TelosItemSources: () => null }));
vi.mock('../../components/WorkOutputs', () => ({ WorkOutputs: () => null }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});
it.each(['/todos', '/todos/qc-parent'])(
  'shows ten persisted report children at %s without legacy listing or hydration requests',
  async (path) => {
    markAuthLost();
    const template = createTelosWorkFixtures().homeStudio.items[0];
    const parent = {
      ...template,
      itemId: 'qc-parent',
      summary: 'Quarterly Connections',
      kind: null,
    };
    const records = [
      parent,
      ...Array.from({ length: 10 }, (_, i) => ({
        ...template,
        itemId: `report-${i}`,
        parentId: parent.itemId,
        summary: `Associate ${i}`,
        kind: null,
        profile: 'manual',
      })),
    ];
    const reads: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      reads.push(url);
      if (url === '/api/telos/work/collection')
        return Response.json({ records, profiles: ['work', 'manual'], failures: [] });
      if (url === '/api/telos/work/items/qc-parent/record') return Response.json(parent);
      if (url.endsWith('/lifecycle')) return Response.json({}, { status: 503 });
      const id = /\/items\/([^/]+)$/.exec(url)?.[1];
      if (id)
        return Response.json({
          itemId: id,
          kind: null,
          parentId: id === 'qc-parent' ? null : 'qc-parent',
          revision: 'a'.repeat(64),
          links: [],
          assignments: [],
          sources: [],
          attempts: [],
        });
      throw Error(`Unexpected read ${url}`);
    });
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/todos/:id?" element={<TodoWorkspace />} />
        </Routes>
      </MemoryRouter>,
    );
    const root = await screen.findByRole('button', { name: 'Associate 0' }).catch(async () => {
      const expand = await screen.findByRole('button', { name: 'Expand Quarterly Connections' });
      expand.click();
      return screen.findByRole('button', { name: 'Associate 0' });
    });
    expect(root).toBeTruthy();
    const tree = screen.getByRole('region', {
      name: path === '/todos' ? 'Outcomes tree' : 'Child work',
    });
    for (let i = 0; i < 10; i++)
      expect(within(tree).getByRole('button', { name: `Associate ${i}` })).toBeTruthy();
    expect(reads.filter((url) => url === '/api/telos/work/collection')).toHaveLength(1);
    expect(reads.some((url) => url.startsWith('/api/todos') || url.includes('/work/records'))).toBe(
      false,
    );
  },
);

it('keeps the canonical desktop frame while its exact item read is pending', async () => {
  markAuthLost();
  const record = {
    ...createTelosWorkFixtures().homeStudio.items[0],
    itemId: 'pending-item',
    parentId: null,
  };
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/api/telos/work/collection')
      return Response.json({ records: [record], profiles: ['manual'], failures: [] });
    if (url.endsWith('/record')) return pending;
    return Response.json({}, { status: 503 });
  });
  const view = render(
    <MemoryRouter initialEntries={['/todos/pending-item']}>
      <Routes>
        <Route path="/todos/:id?" element={<TodoWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: record.summary });
  expect(view.container.querySelector('.todo-detail-page:not(.telos-canonical-page)')).toBeNull();
  release(Response.json(record));
});

it('recovers a repaired child through the related-record warning retry', async () => {
  markAuthLost();
  const parent = {
    ...createTelosWorkFixtures().homeStudio.items[0],
    itemId: 'qc-parent',
    kind: null,
  };
  let repaired = false;
  const child = {
    ...parent,
    itemId: 'bad-child',
    parentId: parent.itemId,
    summary: 'Recovered child',
  };
  const reads: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    reads.push(String(input));
    return String(input) === '/api/telos/work/collection'
      ? Response.json({
          records: repaired ? [parent, child] : [parent],
          profiles: ['work'],
          failures: repaired ? [] : [{ itemId: 'bad-child', code: 'invalid_record' }],
        })
      : String(input).endsWith('/record')
        ? Response.json(parent)
        : Response.json({}, { status: 503 });
  });
  render(
    <MemoryRouter initialEntries={['/todos/qc-parent']}>
      <Routes>
        <Route path="/todos/:id" element={<TodoWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(
    await screen.findByText('Some related outcome records are unavailable.', { exact: false }),
  ).toBeTruthy();
  expect(screen.queryByText('No child work yet.')).toBeNull();
  repaired = true;
  fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }));
  await screen.findByRole('button', { name: child.summary });
  expect(screen.queryByText(/Some related outcome records are unavailable/)).toBeNull();
  expect(reads.filter((url) => url === '/api/telos/work/collection')).toHaveLength(2);
  expect(reads.filter((url) => url === '/api/telos/work/items/qc-parent/record')).toHaveLength(2);
});

it('refreshes the visible legacy fallback during a native outage and refreshes native data after a recovered form save', async () => {
  markAuthLost();
  const record = { ...createTelosWorkFixtures().homeStudio.items[0], kind: null };
  const collection = () => ({ records: [record], profiles: ['work'], failures: [] });
  let nativeGate: ((response: Response) => void) | undefined;
  let delayRetry = false;
  let available = false,
    reads = 0,
    nativeReads = 0,
    created = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/api/telos/work/collection') {
      nativeReads++;
      if (delayRetry) {
        delayRetry = false;
        return new Promise<Response>((resolve) => {
          nativeGate = resolve;
        });
      }
      return available ? Response.json(collection()) : Response.json({}, { status: 503 });
    }
    if (url === '/api/todos') {
      reads++;
      return Response.json(canonicalTodoData(collection()));
    }
    if (url === '/api/todos/outcomes' && init?.method === 'POST') {
      created = true;
      return Response.json({ item: { id: 'new' } });
    }
    return Response.json({}, { status: 503 });
  });
  render(
    <MemoryRouter initialEntries={['/todos']}>
      <TodoWorkspace />
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'Add outcome' });
  delayRetry = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Telos' }));
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.getByRole('button', { name: 'Add outcome' })).toBeTruthy();
  await act(async () => nativeGate!(Response.json({}, { status: 503 })));
  expect(reads).toBe(2);
  fireEvent.click(screen.getByRole('button', { name: 'Add outcome' }));
  fireEvent.change(screen.getByPlaceholderText('Short outcome title'), {
    target: { value: 'New review' },
  });
  for (const placeholder of [
    'What will be true when this is achieved?',
    'Why does this matter?',
    'Done when — one verifiable criterion per line',
    'Milestones — first line is the next action',
  ])
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: 'Reviewed' } });
  available = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Telos' }));
  await waitFor(() => expect(document.querySelector('.telos-canonical-page')).not.toBeNull());
  const before = nativeReads;
  const legacyBeforeSave = reads;
  fireEvent.click(screen.getByRole('button', { name: 'Create outcome' }));
  await waitFor(() => expect(created).toBe(true));
  await waitFor(() => expect(nativeReads).toBe(before + 1));
  expect(reads).toBe(legacyBeforeSave);
});

it('keeps an established fallback mounted while its focused record retry is pending', async () => {
  markAuthLost();
  const record = createTelosWorkFixtures().homeStudio.items[0];
  let retry = false,
    finish!: (value: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/api/telos/work/collection')
      return Response.json({ records: [record], profiles: ['work'], failures: [] });
    if (url.endsWith('/record'))
      return retry
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Response.json({}, { status: 503 });
    return Response.json({}, { status: 503 });
  });
  render(
    <MemoryRouter initialEntries={['/todos/' + record.itemId]}>
      <Routes>
        <Route path="/todos/:id" element={<TodoWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('Outcome workspace unavailable. Showing original Telos fields.');
  const priority = screen.getByRole('combobox', { name: 'Priority' });
  retry = true;
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(priority.isConnected).toBe(true);
  await act(async () => finish(Response.json(record)));
  expect(await screen.findByRole('heading', { name: record.summary })).toBeTruthy();
});

it.each(['completed', 'snoozed'] as const)(
  'keeps the exact parent breadcrumb when its %s parent is omitted from discovery',
  async (status) => {
    markAuthLost();
    const base = createTelosWorkFixtures().homeStudio.items[0];
    const parent = {
      ...base,
      itemId: 'omitted-parent',
      parentId: null,
      summary: 'Retained parent',
      status,
      kind: null,
    };
    const child = {
      ...base,
      itemId: 'active-child',
      parentId: parent.itemId,
      summary: 'Active report',
      kind: null,
    };
    const reads: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      reads.push(url);
      if (url === '/api/telos/work/collection')
        return Response.json({ profiles: ['work'], records: [child], failures: [] });
      if (url === '/api/telos/work/items/active-child/record') return Response.json(child);
      if (url === '/api/telos/work/items/omitted-parent/record') return Response.json(parent);
      return Response.json({}, { status: 503 });
    });
    render(
      <MemoryRouter initialEntries={['/todos/active-child']}>
        <Routes>
          <Route path="/todos/:id" element={<TodoWorkspace />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: parent.summary });
    expect(
      reads.filter((url) => url === '/api/telos/work/items/omitted-parent/record'),
    ).toHaveLength(1);
    expect(reads.filter((url) => url === '/api/telos/work/items/active-child/record')).toHaveLength(
      1,
    );
  },
);

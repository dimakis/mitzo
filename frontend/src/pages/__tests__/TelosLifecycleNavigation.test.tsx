// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { TelosWorkItem, TelosWorkLifecycleCommand } from '@mitzo/protocol';
import { TodoWorkspace } from '../TodoWorkspace';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import { createTelosLifecycleFixture } from '../../test-utils/telos-lifecycle-fixtures';
import { markAuthLost } from '../../lib/api-fetch';
import type { TodoItem } from '../../types/todo';
const auth = vi.hoisted(() => ({ id: 'fixture-operator', base: '' }));
vi.mock('../../lib/api-fetch', async (load) => ({
  ...(await load<typeof import('../../lib/api-fetch')>()),
  currentVerifiedAuthSessionId: () => auth.id || undefined,
  getApiBaseUrl: () => auth.base,
}));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: Record<string, unknown>) => unknown) =>
    select({ newSession: vi.fn(), setPendingSession: vi.fn() }),
}));
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: { on: () => () => {}, onConnectionChange: () => () => {} },
}));
vi.mock('../../components/TelosItemRoleEntries', () => ({ TelosItemRoleEntries: () => null }));
vi.mock('../../components/TelosItemSources', () => ({ TelosItemSources: () => null }));
vi.mock('../../components/WorkOutputs', () => ({
  WorkOutputs: () => <p>Retained saved outputs</p>,
}));
let records: TelosWorkItem[];
let lifecycle: ReturnType<typeof createTelosLifecycleFixture>;
let canonicalUnavailable: boolean;
let writes: TelosWorkLifecycleCommand[];
let requests: string[];
function legacy(record: TelosWorkItem): TodoItem {
  const children = records.filter((row) => row.parentId === record.itemId).map(legacy);
  return {
    id: record.itemId,
    summary: record.summary,
    parentId: record.parentId,
    profile: 'manual',
    priority: record.priority,
    urgency: 1,
    starred: false,
    status: 'active',
    ageDays: 0,
    children,
    childCount: children.length,
    completedChildCount: 0,
    goalId: null,
    sources: [],
    links: [],
    contextHints: record.contextHints,
  };
}
function Location() {
  const location = useLocation();
  return (
    <>
      <output aria-label="Route">{location.pathname + location.search}</output>
      <output aria-label="State">{JSON.stringify(location.state)}</output>
    </>
  );
}
function mount(path = '/todos', state: Record<string, unknown> = {}) {
  render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: path.split('?')[0],
          search: path.includes('?') ? '?' + path.split('?')[1] : '',
          state,
        },
      ]}
    >
      <Location />
      <Routes>
        <Route path="/todos/:id?" element={<TodoWorkspace />} />
        <Route path="/" element={<p>Home return</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
const route = () => screen.getByLabelText('Route').textContent;
const navState = () => JSON.parse(screen.getByLabelText('State').textContent!);
async function viewMenu(label: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Outcome views' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: label }));
}
async function deleteItem() {
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Item actions' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Item actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox'), {
    target: { value: 'DELETE PERMANENTLY' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
}
beforeEach(() => {
  markAuthLost();
  localStorage.clear();
  sessionStorage.clear();
  const original = createTelosWorkFixtures().homeStudio.items[0];
  records = [
    { ...original, itemId: 'selected', summary: 'Original retained outcome', parentId: null },
    {
      ...original,
      itemId: 'child',
      summary: 'Original child work',
      parentId: 'selected',
      kind: 'work_item',
    },
  ];
  lifecycle = createTelosLifecycleFixture();
  canonicalUnavailable = false;
  writes = [];
  requests = [];
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'https://fixture.invalid');
    requests.push(url.pathname + url.search);
    if (url.pathname === '/api/todos') {
      const disposition =
        lifecycle.effectiveDisposition === 'active'
          ? 'active'
          : lifecycle.effectiveDisposition === 'archived'
            ? 'archive'
            : 'trash';
      return Response.json({
        profiles: ['manual'],
        items:
          (url.searchParams.get('view') ?? 'active') === disposition
            ? records.filter((row) => !row.parentId).map(legacy)
            : [],
      });
    }
    if (url.pathname === '/api/telos/work/lifecycle' && init?.method === 'POST') {
      const command = JSON.parse(String(init.body)) as TelosWorkLifecycleCommand;
      writes.push(command);
      if (command.operation === 'delete_permanently') {
        records = records.filter((record) => record.itemId !== command.itemId);
        return Response.json({
          requestId: command.requestId,
          itemId: command.itemId,
          operation: command.operation,
          lifecycle: null,
        });
      }
      const disposition =
        command.operation === 'archive'
          ? 'archived'
          : command.operation === 'trash'
            ? 'trashed'
            : 'active';
      lifecycle = {
        ...createTelosLifecycleFixture('running', disposition),
        revision: 'b'.repeat(64),
      };
      return Response.json({
        requestId: command.requestId,
        itemId: command.itemId,
        operation: command.operation,
        lifecycle,
      });
    }
    const match = url.pathname.match(/^\/api\/telos\/work\/items\/([^/]+)\/(record|lifecycle)$/);
    if (match?.[2] === 'lifecycle') return Response.json({ ...lifecycle, itemId: match[1] });
    if (match?.[2] === 'record') {
      const record = records.find((row) => row.itemId === match[1]);
      return record && !canonicalUnavailable
        ? Response.json(record)
        : Response.json({ error: 'Unavailable', code: 'fixture_unavailable' }, { status: 503 });
    }
    if (url.pathname === '/api/home/preferences')
      return Response.json({
        revision: 0,
        names: { briefing: 'Minion', terminal: 'Minion' },
        pins: [],
      });
    throw Error('Unexpected offline fixture request: ' + raw);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('selects actual archive/trash collections and preserves the original collection and opaque context through item Back', async () => {
  lifecycle = createTelosLifecycleFixture('running', 'archived');
  mount('/todos', { opaque: { retained: 'Files and Home context' } });
  await viewMenu('Archive');
  expect(route()).toBe('/todos?view=archive');
  fireEvent.click(await screen.findByRole('button', { name: records[0].summary }));
  await screen.findByRole('heading', { name: records[0].summary });
  expect(navState().telosCollectionView).toBe('archive');
  expect(navState().opaque).toEqual({ retained: 'Files and Home context' });
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await waitFor(() => expect(route()).toBe('/todos?view=archive'));
  await screen.findByRole('button', { name: records[0].summary });
  await viewMenu('Trash');
  expect(route()).toBe('/todos?view=trash');
  await waitFor(() => expect(requests).toContain('/api/todos?view=trash'));
  expect(screen.queryByRole('button', { name: records[0].summary })).toBeNull();
  expect(writes).toEqual([]);
});
it('archives only after review, keeps the selected workspace and archived child work readable, then returns to the original Active collection', async () => {
  mount('/todos/selected', { telosCollectionView: 'active', opaque: 'retained' });
  await screen.findByRole('heading', { name: records[0].summary });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Item actions' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Item actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
  expect(writes).toEqual([]);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive' }));
  await screen.findByText('Archived');
  expect(route()).toBe('/todos/selected');
  expect(writes).toHaveLength(1);
  expect(writes[0].operation).toBe('archive');
  await waitFor(() => expect(requests).toContain('/api/todos?view=archive'));
  fireEvent.click(screen.getByRole('button', { name: 'Work' }));
  await screen.findByRole('button', { name: 'Original child work' });
  expect(navState().telosCollectionView).toBe('active');
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await waitFor(() => expect(route()).toBe('/todos'));
  expect(navState().opaque).toBe('retained');
  await viewMenu('Archive');
  await screen.findByRole('button', { name: 'Original retained outcome' });
});
for (const target of ['collection', 'parent', 'home'] as const)
  it(`returns to the retained ${target} context only after separately confirmed successful deletion`, async () => {
    lifecycle = createTelosLifecycleFixture('running', 'trashed');
    records = [records[0], { ...records[0], itemId: 'parent', summary: 'Retained parent' }];
    const state = {
      telosCollectionView: 'trash',
      telosHistory: target === 'parent' ? ['parent'] : [],
      opaque: { retained: true },
      ...(target === 'home'
        ? {
            telosItemReturn: {
              path: '/?view=Today#saved',
              state: { homeQuery: 'Original home query' },
            },
          }
        : {}),
    };
    mount('/todos/selected', state);
    await screen.findByRole('heading', { name: records[0].summary });
    await deleteItem();
    await waitFor(() =>
      expect(route()).toBe(
        target === 'collection'
          ? '/todos?view=trash'
          : target === 'parent'
            ? '/todos/parent'
            : '/?view=Today',
      ),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].operation).toBe('delete_permanently');
    if (target === 'home') expect(navState()).toEqual({ homeQuery: 'Original home query' });
    else expect(navState().opaque).toEqual({ retained: true });
  });
it('keeps original-snapshot controls and Back available when canonical detail is unavailable in Archive', async () => {
  lifecycle = createTelosLifecycleFixture('running', 'archived');
  canonicalUnavailable = true;
  mount('/todos/selected', {
    item: legacy(records[0]),
    telosCollectionView: 'archive',
    opaque: 'original snapshot',
  });
  await screen.findByText('Archived');
  expect(screen.getByText('Original retained outcome')).toBeTruthy();
  expect(screen.getByText('Retained saved outputs')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await waitFor(() => expect(route()).toBe('/todos?view=archive'));
  expect(navState().opaque).toBe('original snapshot');
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { TodoWorkspace } from '../TodoWorkspace';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import { markAuthLost } from '../../lib/api-fetch';
import type { TelosWorkItem } from '@mitzo/protocol';

vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: Record<string, unknown>) => unknown) =>
    select({ newSession: vi.fn(), setPendingSession: vi.fn() }),
}));
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: { on: () => () => {}, onConnectionChange: () => () => {} },
}));
vi.mock('../../components/TelosItemRoleEntries', () => ({ TelosItemRoleEntries: () => null }));
vi.mock('../../components/TelosItemSources', () => ({ TelosItemSources: () => null }));
vi.mock('../../components/WorkOutputs', () => ({ WorkOutputs: () => null }));
vi.mock('../../components/HomePinButton', () => ({ HomePinButton: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const template = createTelosWorkFixtures().homeStudio.items[0];
let records: TelosWorkItem[];
let canonical: ReturnType<typeof deferred<void>>;
let response: ReturnType<typeof deferred<{ ok: boolean; status: number }>>;
let writes: { id: string; priority: number }[];
const select = () => screen.getByRole('combobox', { name: 'Priority' }) as HTMLSelectElement;
const warning = 'Couldn’t confirm this priority. Refresh to check its status.';
function legacy(record: TelosWorkItem) {
  return {
    id: record.itemId,
    summary: record.summary,
    profile: record.profile,
    priority: record.priority,
    urgency: 1,
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
}
function open() {
  render(
    <MemoryRouter
      initialEntries={[{ pathname: '/todos/first', state: { item: legacy(records[0]) } }]}
    >
      <Link to="/todos/second">Open second item</Link>
      <Routes>
        <Route path="/todos/:id" element={<TodoWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByRole('heading', { name: 'Task' })).toBeTruthy();
  expect(select().value).toBe('10');
}
async function hydrate() {
  await act(async () => canonical.resolve());
  await screen.findByRole('article');
  expect(screen.getByRole('heading', { name: 'First canonical outcome' })).toBeTruthy();
}
async function settle(ok: boolean) {
  await act(async () => response.resolve({ ok, status: ok ? 200 : 503 }));
}
beforeEach(() => {
  markAuthLost();
  localStorage.clear();
  sessionStorage.clear();
  writes = [];
  records = [
    {
      ...template,
      itemId: 'first',
      parentId: null,
      summary: 'First canonical outcome',
      priority: 10,
    },
    {
      ...template,
      itemId: 'second',
      parentId: null,
      summary: 'Second canonical outcome',
      priority: 4,
    },
  ];
  canonical = deferred<void>();
  response = deferred();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'https://offline.test',
    );
    if (url.pathname === '/api/todos')
      return Response.json({ profiles: ['manual'], items: records.map(legacy) });
    const record = url.pathname.match(/^\/api\/telos\/work\/items\/([^/]+)\/record$/);
    if (record) {
      if (record[1] === 'first') await canonical.promise;
      return Response.json(records.find((r) => r.itemId === record[1]));
    }
    const write = url.pathname.match(/^\/api\/todos\/([^/]+)\/action$/);
    if (write && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      expect(body.action).toBe('priority');
      writes.push({ id: write[1], priority: body.priority });
      const result = await response.promise;
      if (result.ok)
        records = records.map((r) =>
          r.itemId === write[1] ? { ...r, priority: body.priority } : r,
        );
      return Response.json({ ok: result.ok }, { status: result.status });
    }
    throw Error('Unexpected request ' + url.pathname);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  markAuthLost();
});

it('retains a real 503 warning and confirmed value when canonical hydration follows refusal', async () => {
  open();
  fireEvent.change(select(), { target: { value: '2' } });
  await settle(false);
  expect((await screen.findByRole('alert')).textContent).toBe(warning);
  await hydrate();
  expect(screen.getByRole('alert').textContent).toBe(warning);
  expect(select().getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  expect(select().value).toBe('10');
  expect(select().disabled).toBe(false);
  expect(writes).toEqual([{ id: 'first', priority: 2 }]);
});

it('keeps an in-flight save disabled across hydration and announces its later 503 without overlap', async () => {
  open();
  fireEvent.change(select(), { target: { value: '2' } });
  expect(select().disabled).toBe(true);
  await hydrate();
  expect(select().disabled).toBe(true);
  expect(select().getAttribute('aria-busy')).toBe('true');
  expect(select().value).toBe('10');
  fireEvent.change(select(), { target: { value: '3' } });
  expect(writes).toEqual([{ id: 'first', priority: 2 }]);
  await settle(false);
  expect((await screen.findByRole('alert')).textContent).toBe(warning);
  expect(select().value).toBe('10');
  expect(select().disabled).toBe(false);
  expect(writes).toEqual([{ id: 'first', priority: 2 }]);
});

it.each(['before', 'after'])(
  'publishes an acknowledged save %s hydration without replay',
  async (order) => {
    open();
    fireEvent.change(select(), { target: { value: '2' } });
    if (order === 'before') {
      await settle(true);
      await hydrate();
    } else {
      await hydrate();
      await settle(true);
    }
    await waitFor(() => expect(select().value).toBe('2'));
    expect(select().disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(writes).toEqual([{ id: 'first', priority: 2 }]);
  },
);

it('accepts a newer canonical priority after this item save succeeds before hydration', async () => {
  open();
  fireEvent.change(select(), { target: { value: '2' } });
  await settle(true);
  records[0] = { ...records[0], priority: 8 };
  await hydrate();
  await waitFor(() => expect(select().value).toBe('8'));
  expect(select().disabled).toBe(false);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(writes).toEqual([{ id: 'first', priority: 2 }]);
});

it.each([false, true])(
  'does not transfer a late first-item result (success=%s) into another canonical item',
  async (ok) => {
    open();
    fireEvent.change(select(), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('link', { name: 'Open second item' }));
    await screen.findByRole('heading', { name: 'Second canonical outcome' });
    expect(select().value).toBe('4');
    expect(select().disabled).toBe(false);
    await settle(ok);
    await act(async () => canonical.resolve());
    expect(select().value).toBe('4');
    expect(select().disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(writes).toEqual([{ id: 'first', priority: 2 }]);
  },
);

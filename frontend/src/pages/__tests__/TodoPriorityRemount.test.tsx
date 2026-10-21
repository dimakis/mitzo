// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { TodoWorkspace } from '../TodoWorkspace';
import { useTodoData, useLatestTodoPriority } from '../../hooks/useTodoData';
import type { TodoItem } from '../../types/todo';

const viewport = vi.hoisted(() => ({ desktop: false }));
vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: () => viewport.desktop }));
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: { on: () => () => {}, onConnectionChange: () => () => {} },
}));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (selector: (value: object) => unknown) => selector({ setPendingSession: vi.fn() }),
}));
vi.mock('../../components/TelosItemRoleEntries', () => ({ TelosItemRoleEntries: () => null }));
vi.mock('../../components/TelosItemSources', () => ({ TelosItemSources: () => null }));
vi.mock('../../components/WorkOutputs', () => ({ WorkOutputs: () => null }));
vi.mock('../../components/HomePinButton', () => ({ HomePinButton: () => null }));

const navigationItem: TodoItem = {
  id: 'remount-item',
  summary: 'Retain confirmed priority',
  profile: 'work',
  priority: 5,
  urgency: 0.5,
  starred: false,
  status: 'active',
  ageDays: 0,
  parentId: null,
  children: [],
  childCount: 0,
  completedChildCount: 0,
  goalId: null,
  sources: [],
  contextHints: {
    repos: [],
    paths: [],
    issues: [],
    docIds: [],
    people: [],
    jiraKeys: [],
    keywords: [],
    taskHint: '',
  },
};
const otherItem = { ...navigationItem, id: 'other-item', summary: 'Another item', priority: 4 };

function WorkspaceRoute() {
  return (
    <>
      <output aria-label="Route">{useLocation().pathname}</output>
      <Link to="/todos/other-item" state={{ item: otherItem, activeProfile: 'work' }}>
        Other item
      </Link>
      {/* Mirrors the host replacing its shell at the responsive breakpoint. */}
      <TodoWorkspace key={viewport.desktop ? 'desktop' : 'mobile'} />
    </>
  );
}
function app() {
  return (
    <MemoryRouter
      initialEntries={[
        { pathname: '/todos/remount-item', state: { item: navigationItem, activeProfile: 'work' } },
      ]}
    >
      <Routes>
        <Route path="/todos/:id" element={<WorkspaceRoute />} />
      </Routes>
    </MemoryRouter>
  );
}
beforeEach(() => {
  window.dispatchEvent(new Event('mitzo:auth-lost'));
  viewport.desktop = false;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(['missing', 'failed'])(
  'retains confirmed fallback priority across responsive host remounts with a %s read',
  async (outcome) => {
    let authoritative: number | undefined;
    let persisted = 5;
    const writes: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (url === '/api/todos/remount-item/action') {
        const priority = JSON.parse(init!.body as string).priority;
        writes.push(priority);
        if (priority === 9) return Response.json({ ok: false }, { status: 503 });
        persisted = priority;
        return Response.json({ ok: true });
      }
      if (url === '/api/todos?profile=work')
        return Response.json({
          profiles: ['work'],
          items: [{ ...navigationItem, priority: persisted }],
        });
      if (url === '/api/todos') {
        if (authoritative !== undefined)
          return Response.json({
            profiles: ['work'],
            items: [{ ...navigationItem, priority: authoritative }],
          });
        return outcome === 'failed'
          ? Response.json({}, { status: 503 })
          : Response.json({ profiles: ['work'], items: [] });
      }
      throw Error('Unexpected fixture request: ' + String(url));
    });
    const filtered = renderHook(() => useTodoData('work'));
    await waitFor(() => expect(filtered.result.current.loading).toBe(false));
    const view = render(app());
    const select = () => screen.getByRole('combobox', { name: 'Priority' }) as HTMLSelectElement;
    fireEvent.change(select(), { target: { value: '7' } });
    await waitFor(() => expect(select().value).toBe('7'));
    await waitFor(() => expect(filtered.result.current.items[0].priority).toBe(7));
    expect(navigationItem.priority).toBe(5);
    const previousDetail = view.container.querySelector('.todo-detail-page');
    viewport.desktop = true;
    view.rerender(app());
    await waitFor(() => {
      expect(view.container.querySelector('.todo-detail-page')).toBeTruthy();
      expect(view.container.querySelector('.todo-detail-page')).not.toBe(previousDetail);
    });
    expect(select().value).toBe('7');
    await waitFor(() => expect(select().disabled).toBe(false));
    fireEvent.change(select(), { target: { value: '9' } });
    await screen.findByText('Couldn’t confirm this priority. Refresh to check its status.');
    viewport.desktop = false;
    view.rerender(app());
    expect(select().value).toBe('7');
    expect(screen.getByLabelText('Route').textContent).toBe('/todos/remount-item');
    authoritative = 3;
    const current = renderHook(() => useTodoData());
    act(() => current.result.current.refresh());
    await waitFor(() => expect(select().value).toBe('3'));
    authoritative = undefined;
    persisted = 3;
    act(() => current.result.current.refresh());
    await waitFor(() => expect(current.result.current.refreshing).toBe(false));
    viewport.desktop = true;
    view.rerender(app());
    expect(select().value).toBe('3');
    fireEvent.click(screen.getByRole('link', { name: 'Other item' }));
    await waitFor(() => expect(select().value).toBe('4'));
    expect(screen.getByLabelText('Route').textContent).toBe('/todos/other-item');
    expect(navigationItem.priority).toBe(5);
    expect(writes).toEqual([7, 9]);
  },
);

it.each(['missing', 'failed'])(
  'publishes a delayed confirmation after a responsive host remount with a %s read',
  async (outcome) => {
    let finish!: (response: Response) => void;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url === '/api/todos/remount-item/action')
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      if (url === '/api/todos')
        return outcome === 'failed'
          ? Response.json({}, { status: 503 })
          : Response.json({ profiles: ['work'], items: [] });
      throw Error('Unexpected fixture request: ' + String(url));
    });
    const view = render(app());
    const select = () => screen.getByRole('combobox', { name: 'Priority' }) as HTMLSelectElement;
    fireEvent.change(select(), { target: { value: '7' } });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    const previousDetail = view.container.querySelector('.todo-detail-page');
    viewport.desktop = true;
    view.rerender(app());
    await waitFor(() => {
      expect(view.container.querySelector('.todo-detail-page')).toBeTruthy();
      expect(view.container.querySelector('.todo-detail-page')).not.toBe(previousDetail);
    });
    expect(select().value).toBe('5');
    await act(async () => {
      finish(Response.json({ ok: true }));
    });
    await waitFor(() => expect(select().value).toBe('7'));
    expect(screen.getByLabelText('Route').textContent).toBe('/todos/remount-item');
    expect(navigationItem.priority).toBe(5);
    expect(
      fetch.mock.calls.filter(([url]) => url === '/api/todos/remount-item/action'),
    ).toHaveLength(1);
  },
);

it.each(['mitzo:auth-lost', 'mitzo:auth-restored'])(
  'clears remembered fallback priorities at the list-cache boundary %s',
  async (event) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ profiles: ['work'], items: [{ ...navigationItem, priority: 7 }] }),
    );
    const read = renderHook(() => useTodoData());
    const fallback = renderHook(() => useLatestTodoPriority(navigationItem));
    await waitFor(() => expect(read.result.current.loading).toBe(false));
    expect(fallback.result.current?.priority).toBe(7);
    act(() => window.dispatchEvent(new Event(event)));
    expect(fallback.result.current?.priority).toBe(5);
  },
);

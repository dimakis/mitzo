// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { TelosWorkItem } from '@mitzo/protocol';
import type { TodoItem } from '../../types/todo';
import { TodoWorkspace } from '../TodoWorkspace';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import { markAuthLost } from '../../lib/api-fetch';

vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: Record<string, unknown>) => unknown) =>
    select({ newSession: vi.fn(), setPendingSession: vi.fn() }),
}));
vi.mock('../../lib/event-bus-singleton', () => ({ eventBus: { on: () => () => {} } }));
vi.mock('../../components/TelosItemRoleEntries', () => ({ TelosItemRoleEntries: () => null }));
vi.mock('../../components/TelosItemSources', () => ({ TelosItemSources: () => null }));
vi.mock('../../components/WorkOutputs', () => ({ WorkOutputs: () => null }));

const root = createTelosWorkFixtures().homeStudio.items[0];
let records: TelosWorkItem[];
let rowHeight: number;
const resizeCallbacks = new Set<() => void>();
let recordGate: Promise<void> | undefined;
let collectionGate: Promise<void> | undefined;
let releaseRecords: (() => void) | undefined;
let releaseCollection: (() => void) | undefined;
const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
function legacy(record: TelosWorkItem): TodoItem {
  const children = records.filter((row) => row.parentId === record.itemId).map(legacy);
  return {
    id: record.itemId,
    summary: record.summary,
    profile: 'manual',
    urgency: 1,
    priority: record.priority,
    starred: false,
    status: 'active',
    ageDays: 0,
    parentId: record.parentId,
    children,
    childCount: children.length,
    completedChildCount: 0,
    sources: [],
    links: [],
    contextHints: record.contextHints,
    goalId: null,
  };
}
function holdRecords() {
  recordGate = new Promise<void>((resolve) => {
    releaseRecords = () => {
      recordGate = undefined;
      resolve();
    };
  });
}
function mount(scrollTop?: number) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/todos', state: { scrollTop } }]}>
      <Routes>
        <Route path="/todos/:id?" element={<TodoWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );
}
const scroller = () => document.querySelector<HTMLElement>('.todo-scroll')!;
beforeEach(() => {
  markAuthLost();
  localStorage.clear();
  sessionStorage.clear();
  records = [
    root,
    ...Array.from({ length: 12 }, (_, i) => ({
      ...root,
      itemId: `scroll-child-${i}`,
      parentId: root.itemId,
      kind: 'work_item' as const,
      summary: `Deep child ${i}`,
    })),
  ];
  localStorage.setItem(
    'telos.outcomes.navigation.v1',
    JSON.stringify({
      query: '',
      category: 'All',
      pins: [],
      expanded: [root.itemId],
      filter: 'All outcomes',
    }),
  );
  rowHeight = 120;
  resizeCallbacks.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class implements ResizeObserver {
      private notify: () => void;
      constructor(callback: ResizeObserverCallback) {
        this.notify = () => callback([], this);
      }
      observe() {
        resizeCallbacks.add(this.notify);
      }
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.notify);
      }
    },
  );
  recordGate = undefined;
  collectionGate = undefined;
  releaseRecords = undefined;
  releaseCollection = undefined;
  // jsdom has no layout/clamping. Model the browser's scroll bounds from the
  // rendered rows: the collapsed legacy list is short; the expanded tree is tall.
  const positions = new WeakMap<Element, number>();
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get() {
      return positions.get(this) ?? 0;
    },
    set(value: number) {
      const max = this.matches('.todo-scroll')
        ? Math.max(0, this.querySelectorAll('.telos-tree-row').length * rowHeight - 500)
        : Number.MAX_SAFE_INTEGER;
      positions.set(this, Math.max(0, Math.min(value, max)));
    },
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(path, 'https://mitzo-ui.test');
    if (url.pathname === '/api/todos') {
      await collectionGate;
      return Response.json({
        profiles: ['manual'],
        items: records.filter((r) => !r.parentId).map(legacy),
      });
    }
    const match = url.pathname.match(/^\/api\/telos\/work\/items\/([^/]+)(\/record)?$/);
    if (match) {
      const record = records.find((r) => r.itemId === match[1])!;
      if (match[2]) {
        await recordGate;
        return Response.json(record);
      }
      return Response.json({
        itemId: record.itemId,
        kind: record.kind,
        parentId: record.parentId,
        revision: 'f'.repeat(64),
        links: [],
        assignments: [],
        sources: [],
        attempts: [],
      });
    }
    if (url.pathname === '/api/home/preferences')
      return Response.json({
        revision: 0,
        names: { briefing: 'Minion', terminal: 'Minion' },
        pins: [],
      });
    throw Error('Unexpected fixture request: ' + path);
  });
});
afterEach(() => {
  cleanup();
  releaseRecords?.();
  releaseCollection?.();
  Object.defineProperty(Element.prototype, 'scrollTop', scrollDescriptor);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('restores a deeply scrolled expanded tree after focused item Back and delayed canonical hydration', async () => {
  mount();
  await screen.findByRole('button', { name: 'Deep child 11' });
  const original = scroller();
  original.scrollTop = 600;
  expect(original.scrollTop).toBe(600);
  fireEvent.click(screen.getByRole('button', { name: 'Deep child 11' }));
  await screen.findByRole('heading', { name: 'Deep child 11' });
  await waitFor(() => expect(document.querySelector('.telos-item-workspace')).toBeTruthy());
  expect(document.querySelector('.todo-scroll')).toBeNull();
  holdRecords();
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await waitFor(() => expect(document.querySelector('.todo-card')).toBeTruthy());
  expect(scroller()).not.toBe(original);
  expect(scroller().scrollTop).toBe(0);
  await act(async () => {
    releaseRecords!();
  });
  await screen.findByRole('button', { name: 'Deep child 11' });
  await waitFor(() => expect(scroller().scrollTop).toBe(600));
});
it('waits for cold collection discovery and canonical rows before restoring retained navigation state', async () => {
  collectionGate = new Promise<void>((resolve) => {
    releaseCollection = () => {
      collectionGate = undefined;
      resolve();
    };
  });
  holdRecords();
  mount(600);
  await screen.findByText('Loading outcomes…');
  expect(scroller().scrollTop).toBe(0);
  await act(async () => {
    releaseCollection!();
  });
  await waitFor(() => expect(document.querySelector('.todo-card')).toBeTruthy());
  expect(scroller().scrollTop).toBe(0);
  await act(async () => {
    releaseRecords!();
  });
  await screen.findByRole('button', { name: 'Deep child 11' });
  await waitFor(() => expect(scroller().scrollTop).toBe(600));
});
it('retains subsequent manual scroll when canonical records refresh on the same collection visit', async () => {
  mount(600);
  await screen.findByRole('button', { name: 'Deep child 11' });
  await waitFor(() => expect(scroller().scrollTop).toBe(600));
  fireEvent.wheel(scroller(), { deltaY: -100 });
  scroller().scrollTop = 100;
  records[0] = { ...records[0], summary: 'Refreshed studio' };
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Telos' }));
  await screen.findByRole('button', { name: 'Refreshed studio' });
  expect(scroller().scrollTop).toBe(100);
});

it('finishes restoration when later row layout makes the saved position reachable', async () => {
  rowHeight = 60;
  mount(900);
  await screen.findByRole('button', { name: 'Deep child 11' });
  expect(scroller().scrollTop).toBeLessThan(900);
  rowHeight = 120;
  resizeCallbacks.forEach((notify) => notify());
  await waitFor(() => expect(scroller().scrollTop).toBe(900));
});
it('lets user input cancel pending restoration before later content growth', async () => {
  rowHeight = 60;
  mount(900);
  await screen.findByRole('button', { name: 'Deep child 11' });
  const queuedResizes = [...resizeCallbacks];
  fireEvent.wheel(scroller(), { deltaY: -100 });
  scroller().scrollTop = 100;
  rowHeight = 120;
  queuedResizes.forEach((notify) => notify());
  expect(scroller().scrollTop).toBe(100);
});

it('lets user input cancel Back restoration while canonical records are still loading', async () => {
  holdRecords();
  mount(600);
  await waitFor(() => expect(document.querySelector('.todo-card')).toBeTruthy());
  fireEvent.wheel(scroller(), { deltaY: -100 });
  await act(async () => {
    releaseRecords!();
  });
  await screen.findByRole('button', { name: 'Deep child 11' });
  expect(scroller().scrollTop).toBe(0);
});

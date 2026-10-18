// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { TelosWorkItem } from '@mitzo/protocol';
import type { TodoItem } from '../../types/todo';
import { TodoWorkspace } from '../TodoWorkspace';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import { markAuthLost } from '../../lib/api-fetch';

vi.mock('../../lib/event-bus-singleton', () => ({ eventBus: { on: () => () => {} } }));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: Record<string, unknown>) => unknown) =>
    select({ newSession: vi.fn(), setPendingSession: vi.fn() }),
}));
vi.mock('../../components/TelosItemRoleEntries', () => ({ TelosItemRoleEntries: () => null }));
vi.mock('../../components/TelosItemSources', () => ({ TelosItemSources: () => null }));
vi.mock('../../components/WorkOutputs', () => ({ WorkOutputs: () => null }));

const home = createTelosWorkFixtures().homeStudio.items[0];
const records: TelosWorkItem[] = [
  { ...home, parentId: null, profile: 'manual' },
  {
    ...home,
    itemId: 'fixture-software',
    summary: 'Build a release dashboard',
    parentId: null,
    profile: 'work',
    categories: ['Software'],
  },
];
function legacy(record: TelosWorkItem): TodoItem {
  return {
    id: record.itemId,
    summary: record.summary,
    intent: record.intent,
    profile: record.profile,
    urgency: 1,
    priority: record.priority,
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
let unavailable: boolean;
let unavailableCollection: boolean;
let reads: string[];
beforeEach(() => {
  markAuthLost();
  localStorage.clear();
  sessionStorage.clear();
  unavailable = true;
  unavailableCollection = false;
  reads = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    reads.push(path);
    const url = new URL(path, 'https://mitzo-ui.test');
    if (url.pathname === '/api/todos') {
      const profile = url.searchParams.get('profile');
      if (!profile && unavailableCollection) return Response.json({}, { status: 503 });
      return Response.json({
        profiles: ['manual', 'work'],
        items: records.filter((record) => !profile || record.profile === profile).map(legacy),
      });
    }
    const match = url.pathname.match(/^\/api\/telos\/work\/items\/([^/]+)(\/record)?$/);
    if (match) {
      const record = records.find((value) => value.itemId === match[1]);
      if (!record) throw Error('Unknown fixture identity');
      if (match[2]) return unavailable ? Response.json({}, { status: 503 }) : Response.json(record);
      return Response.json({
        itemId: record.itemId,
        kind: record.kind,
        parentId: null,
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
  vi.restoreAllMocks();
});
function mount(activeProfile?: string) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/todos', state: { activeProfile } }]}>
      <Routes>
        <Route path="/todos/:id?" element={<TodoWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );
}
async function expectAllOutcomes() {
  await screen.findByRole('button', { name: home.summary });
  await screen.findByRole('button', { name: records[1].summary });
  expect(screen.getByRole('button', { name: 'All outcomes' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  expect(screen.queryByRole('button', { name: 'work' })).toBeNull();
}
it('recovers every profile after a mounted legacy profile selection and retains that full discovery through detail Back', async () => {
  mount();
  await screen.findByText(
    'Outcome workspace records unavailable. Original Telos fields remain available below.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'work' }));
  await waitFor(() => expect(screen.queryByText(home.summary, { exact: true })).toBeNull());
  await screen.findByText(records[1].summary, { exact: true });
  expect(screen.getByRole('button', { name: 'work' }).getAttribute('aria-pressed')).toBe('true');
  unavailable = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Telos' }));
  await expectAllOutcomes();
  expect(reads.filter((path) => path === '/api/todos')).toHaveLength(2);
  expect(reads.filter((path) => path === '/api/todos?profile=work')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: home.summary }));
  await screen.findByRole('heading', { name: home.summary });
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await expectAllOutcomes();
});
it('discovers every profile when a legacy profile is restored in navigation state', async () => {
  unavailable = false;
  mount('work');
  await expectAllOutcomes();
  expect(reads).toContain('/api/todos');
  expect(reads).toContain('/api/todos?profile=work');
});
it('keeps the selected legacy fallback available while full discovery is unavailable, then recovers the full tree', async () => {
  unavailableCollection = true;
  mount('work');
  await screen.findByText(records[1].summary, { exact: true });
  expect(screen.getByRole('button', { name: 'work' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('region', { name: 'Outcomes tree' })).toBeNull();
  unavailableCollection = false;
  unavailable = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Telos' }));
  await expectAllOutcomes();
});
it('shares the unfiltered read and refresh instead of duplicating identical HTTP requests', async () => {
  unavailable = false;
  mount();
  await expectAllOutcomes();
  expect(reads.filter((path) => path === '/api/todos')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Telos' }));
  await waitFor(() => expect(reads.filter((path) => path === '/api/todos')).toHaveLength(2));
  await expectAllOutcomes();
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { TodoWorkspace } from '../TodoWorkspace';
import type { TodoItem } from '../../types/todo';

const state = vi.hoisted(() => ({ desktop: true }));
vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: () => state.desktop }));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (selector: (s: object) => unknown) => selector({ setPendingSession: vi.fn() }),
}));
const item: TodoItem = {
  id: 'first',
  summary: 'Ship desktop work',
  profile: 'manual',
  urgency: 1,
  starred: true,
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
    taskHint: 'Inspect current pages',
  },
};
vi.mock('../../hooks/useTodoData', () => ({
  useTodoData: () => ({
    loading: false,
    items: [item, { ...item, id: 'second', summary: 'Review desktop work' }],
    profiles: ['manual', 'work'],
    ack: vi.fn(),
    done: vi.fn(),
    star: vi.fn(),
    create: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ items: [item] }),
  })),
}));
function Location() {
  return <output aria-label="Route">{useLocation().pathname}</output>;
}
function mount(path = '/todos') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Location />
      <Routes>
        <Route path="/todos/:id?" element={<TodoWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );
}
afterEach(() => {
  cleanup();
  state.desktop = true;
});
describe('TELOS workspace', () => {
  it('opens desktop details beside the list and keeps the selected filter', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ship desktop work' }));
    const inspector = screen.getByRole('region', { name: 'Work details' });
    expect(within(inspector).getByText('Inspect current pages')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'work' }).className).toContain('--active');
    expect(screen.getByLabelText('Route').textContent).toBe('/todos/first');
    fireEvent.click(screen.getByRole('button', { name: 'Review desktop work' }));
    expect(within(inspector).getByText('Review desktop work')).toBeTruthy();
    expect(within(inspector).queryByText('Ship desktop work')).toBeNull();
    fireEvent.click(within(inspector).getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Select a work item')).toBeTruthy();
  });
  it('loads a bookmarked item beside the desktop list', async () => {
    mount('/todos/first');
    const inspector = screen.getByRole('region', { name: 'Work details' });
    expect(await within(inspector).findByText('Inspect current pages')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review desktop work' })).toBeTruthy();
  });
  it('keeps mobile detail as a separate page', () => {
    state.desktop = false;
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Ship desktop work' }));
    expect(screen.getByText('Inspect current pages')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review desktop work' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Work details' })).toBeNull();
  });
});

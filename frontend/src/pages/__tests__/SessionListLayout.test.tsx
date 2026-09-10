// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionList } from '../SessionList';

const mocks = vi.hoisted(() => ({
  list: {
    sessions: [
      { id: 'one', summary: 'Review UI', lastModified: 30 },
      { id: 'two', summary: 'Older chat', lastModified: 10 },
    ],
    quickActions: [],
    loading: false,
    hasMore: false,
    dismissSession: vi.fn(),
    handleRename: vi.fn(),
    clearAll: vi.fn(),
    checkForUpdates: vi.fn(),
  },
  overview: {
    activities: [
      {
        sessionId: 'one',
        title: 'Review UI',
        state: 'waiting',
        waitReason: 'review',
        lastEventAt: 40,
        awaitingReply: false,
        uncommittedWork: false,
      },
      {
        sessionId: 'three',
        title: 'Live chat outside history page',
        state: 'working',
        lastEventAt: 50,
        awaitingReply: false,
        uncommittedWork: false,
      },
    ],
    connected: true,
  },
  search: {
    query: '',
    setQuery: vi.fn(),
    results: [],
    searching: false,
    active: false,
    clear: vi.fn(),
  },
}));
vi.mock('../../hooks/useSessionList', () => ({ useSessionList: () => mocks.list }));
vi.mock('../../hooks/useSessionOverview', () => ({ useSessionOverview: () => mocks.overview }));
vi.mock('../../hooks/useSessionSearch', () => ({ useSessionSearch: () => mocks.search }));
afterEach(cleanup);
function mount() {
  render(
    <MemoryRouter initialEntries={['/sessions']}>
      <Routes>
        <Route path="/sessions" element={<SessionList />} />
        <Route path="/chat/:id" element={<p>Selected conversation</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
it('renders a single list including live chats outside the loaded history page', () => {
  mount();
  expect(screen.getAllByText('Review UI')).toHaveLength(1);
  expect(screen.getByText('Live chat outside history page')).toBeTruthy();
  expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toBeTruthy();
  expect(screen.queryByText('Quick Actions')).toBeNull();
  expect(screen.queryByText('Active Sessions')).toBeNull();
});
it('filters by activity and attention without duplicating rows', () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: /^Needs attention/ }));
  expect(screen.getByText('Review UI')).toBeTruthy();
  expect(screen.queryByText('Older chat')).toBeNull();
  expect(screen.queryByText('Live chat outside history page')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^Active/ }));
  expect(screen.getByText('Live chat outside history page')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^All/ }));
  expect(screen.getByText('Older chat')).toBeTruthy();
});
it('opens a conversation using the keyboard', () => {
  mount();
  fireEvent.keyDown(screen.getByRole('link', { name: 'Open Review UI' }), { key: 'Enter' });
  expect(screen.getByText('Selected conversation')).toBeTruthy();
});

it('uses the shared workspace page and primary action styling', () => {
  mount();
  expect(screen.getByRole('heading', { name: 'Chats' }).closest('.workspace-page')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: '+ New chat' }).classList.contains('workspace-primary'),
  ).toBe(true);
});

it('does not claim synthetic activity rows are detached when attachment is unknown', () => {
  mount();
  const row = screen.getByRole('link', { name: 'Open Live chat outside history page' });
  expect(row.querySelector('.session-status-dot')).toBeNull();
  expect(row.textContent).toContain('Working');
});

it.each([
  ['done', true, false, true],
  ['idle', true, false, true],
  ['done', false, true, true],
  ['idle', false, true, true],
  ['working', true, true, false],
  ['done', false, false, false],
] as const)(
  'matches attention semantics for %s, reply=%s, uncommitted=%s',
  (state, awaitingReply, uncommittedWork, expected) => {
    const previous = mocks.overview.activities;
    mocks.overview.activities = [{ ...previous[0], state, awaitingReply, uncommittedWork }];
    try {
      mount();
      fireEvent.click(screen.getByRole('button', { name: /^Needs attention/ }));
      expect(screen.queryByText('Review UI') !== null).toBe(expected);
    } finally {
      mocks.overview.activities = previous;
    }
  },
);

it('keeps details and actions outside the conversation navigation control', () => {
  mount();
  const link = screen.getByRole('link', { name: 'Open Review UI' });
  expect(link.querySelector('details, button, input')).toBeNull();
  fireEvent.click(screen.getByLabelText('Details for Review UI'));
  expect(screen.queryByText('Selected conversation')).toBeNull();
  expect(screen.getByLabelText('Details for Review UI').closest('details')?.open).toBe(true);
});

it('clears active search when conversation history is cleared', () => {
  mocks.search.clear.mockClear();
  mocks.list.clearAll.mockClear();
  const previous = mocks.search.active;
  mocks.search.active = true;
  try {
    mount();
    fireEvent.click(screen.getByLabelText('Conversation options'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear conversation history' }));
    expect(mocks.search.clear).toHaveBeenCalledOnce();
    expect(mocks.list.clearAll).toHaveBeenCalledOnce();
  } finally {
    mocks.search.active = previous;
  }
});

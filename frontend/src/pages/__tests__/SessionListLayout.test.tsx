// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
    error: null as string | null,
    retry: vi.fn(),
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
it('presents search failures with retry without claiming there were no matches', () => {
  const previous = { active: mocks.search.active, error: mocks.search.error };
  mocks.search.active = true;
  mocks.search.error = 'Couldn’t search sessions. Try again.';
  mocks.search.retry.mockClear();
  try {
    mount();
    expect(screen.getByRole('alert').textContent).toContain(mocks.search.error);
    expect(screen.queryByText('No matching conversations')).toBeNull();
    expect(screen.queryByText('0 results')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.search.retry).toHaveBeenCalledOnce();
  } finally {
    Object.assign(mocks.search, previous);
  }
});
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
  fireEvent.click(screen.getByRole('button', { name: /^Needs you/ }));
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
    screen.getByRole('button', { name: 'New chat' }).classList.contains('workspace-primary'),
  ).toBe(true);
});

it('does not claim synthetic activity rows are detached when attachment is unknown', () => {
  mount();
  const row = screen.getByRole('link', { name: 'Open Live chat outside history page' });
  expect(row.querySelector('.session-status-dot')).toBeNull();
  expect(row.textContent).toContain('Working');
});

it.each([
  ['done', true, false, false],
  ['idle', true, false, false],
  ['done', false, true, false],
  ['idle', false, true, false],
  ['working', true, true, false],
  ['done', false, false, false],
] as const)(
  'matches attention semantics for %s, reply=%s, uncommitted=%s',
  (state, awaitingReply, uncommittedWork, expected) => {
    const previous = mocks.overview.activities;
    mocks.overview.activities = [{ ...previous[0], state, awaitingReply, uncommittedWork }];
    try {
      mount();
      fireEvent.click(screen.getByRole('button', { name: /^Needs you/ }));
      expect(screen.queryByText('Review UI') !== null).toBe(expected);
    } finally {
      mocks.overview.activities = previous;
    }
  },
);

it('keeps actions outside the conversation navigation control', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  mount();
  const link = screen.getByRole('link', { name: 'Open Review UI' });
  expect(link.querySelector('details, button, input')).toBeNull();
  fireEvent.click(screen.getByLabelText('Actions for Review UI'));
  await act(async () => {});
  expect(screen.queryByText('Selected conversation')).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Preview Review UI' })).toBeTruthy();
});

it.each([true, false])(
  'clears active search only after confirmed history deletion (success=%s)',
  async (ok) => {
    mocks.search.clear.mockClear();
    let finish!: (success: boolean) => void;
    mocks.list.clearAll.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const previous = mocks.search.active;
    mocks.search.active = true;
    try {
      mount();
      fireEvent.click(screen.getByLabelText('Conversation options'));
      fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));
      expect(mocks.search.clear).not.toHaveBeenCalled();
      await act(async () => finish(ok));
      expect(mocks.search.clear).toHaveBeenCalledTimes(ok ? 1 : 0);
      expect(mocks.list.clearAll).toHaveBeenCalledOnce();
    } finally {
      mocks.search.active = previous;
      mocks.list.clearAll.mockClear();
    }
  },
);

it.each(['delete', 'clear'] as const)(
  'keeps hook-provided rows visible until %s is confirmed',
  (action) => {
    vi.useFakeTimers();
    try {
      mount();
      if (action === 'delete') {
        HTMLDialogElement.prototype.showModal = function () {
          this.open = true;
        };
        HTMLDialogElement.prototype.close = function () {
          this.open = false;
        };
        fireEvent.click(screen.getByLabelText('Actions for Review UI'));
        fireEvent.click(
          within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete conversation' }),
        );
        act(() => vi.advanceTimersByTime(200));
      } else {
        fireEvent.click(screen.getByLabelText('Conversation options'));
        fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));
      }
      // The hook still supplies these rows until the server confirms deletion.
      fireEvent.click(screen.getByRole('button', { name: /^Active/ }));
      expect(screen.getByRole('link', { name: 'Open Review UI' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each([0, 2])('shows orchestrated task progress when %s tasks are complete', (done) => {
  const previous = mocks.overview.activities;
  const activity = { ...previous[0], progress: { done, total: 5 } };
  mocks.overview.activities = [activity];
  try {
    mount();
    const row = screen.getByRole('link', { name: 'Open Review UI' });
    expect(within(row).getByText(`${done}/5 tasks`)).toBeTruthy();
  } finally {
    mocks.overview.activities = previous;
  }
});

it('opens a conversation when the row padding is clicked', () => {
  mount();
  const row = screen.getByRole('link', { name: 'Open Review UI' }).closest('.session-item');
  fireEvent.click(row!);
  expect(screen.getByText('Selected conversation')).toBeTruthy();
});

it.each(['double-click', 'Enter'] as const)(
  'previews a desktop row on click and opens it with %s',
  (action) => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => [] })),
    );
    try {
      mount();
      const row = screen
        .getByRole('button', { name: 'Preview Older chat' })
        .closest('.session-item')!;
      fireEvent.click(row);
      expect(screen.queryByText('Selected conversation')).toBeNull();
      expect(
        screen.getByRole('complementary', { name: 'Conversation preview' }).textContent,
      ).toContain('Older chat');
      fireEvent.doubleClick(screen.getByRole('button', { name: 'Actions for Older chat' }));
      expect(screen.queryByText('Selected conversation')).toBeNull();
      if (action === 'double-click') fireEvent.doubleClick(row);
      else
        fireEvent.keyDown(screen.getByRole('button', { name: 'Preview Older chat' }), {
          key: 'Enter',
        });
      expect(screen.getByText('Selected conversation')).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

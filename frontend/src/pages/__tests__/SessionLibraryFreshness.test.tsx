// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SessionList } from '../SessionList';

const saved = vi.hoisted(() => ({
  sessions: [
    { id: 'one', summary: 'First conversation', lastModified: 1 },
    { id: 'two', summary: 'Second conversation', lastModified: 2 },
  ],
}));
vi.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => ({
    sessions: saved.sessions,
    quickActions: [],
    loading: false,
    hasMore: false,
    handleRename: vi.fn(),
    dismissSession: vi.fn(),
    retry: vi.fn(),
  }),
}));
vi.mock('../../hooks/useSessionOverview', () => ({
  useSessionOverview: () => ({
    activities: [],
    lastKnownActivities: [],
    connected: false,
    attendCount: 0,
  }),
}));
vi.mock('../../hooks/useSessionSearch', () => ({
  useSessionSearch: () => ({
    active: false,
    query: '',
    results: [],
    searching: false,
    setQuery: vi.fn(),
    clear: vi.fn(),
  }),
}));
vi.mock('../../hooks/useMediaQuery', () => ({
  useMediaQuery: () => true,
  useIsDesktop: () => true,
}));
vi.mock('../../hooks/useHomePreferences', () => ({
  useHomePreferences: () => ({
    preferences: { revision: 1, pins: [] },
    loading: false,
    saving: false,
    error: null,
    update: vi.fn(),
  }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(120_000);
  saved.sessions = saved.sessions.map((session, index) => ({
    ...session,
    lastModified: index + 1,
  }));
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => [] })),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture() {
  return (
    <MemoryRouter>
      <SessionList />
    </MemoryRouter>
  );
}
function order() {
  return [...document.querySelectorAll('.session-list .session-item-navigation')].map((row) =>
    row.getAttribute('aria-label'),
  );
}
function refresh() {
  saved.sessions = saved.sessions.map((session) =>
    session.id === 'one' ? { ...session, lastModified: 120_000 } : session,
  );
}

it('reconciles authoritative HTTP freshness while the activity stream stays disconnected', async () => {
  const view = render(fixture());
  await act(async () => {});
  expect(order()).toEqual(['Preview Second conversation', 'Preview First conversation']);
  refresh();
  view.rerender(fixture());
  act(() => vi.advanceTimersByTime(1000));
  expect(order()).toEqual(['Preview First conversation', 'Preview Second conversation']);
});

it('keeps browsing stable and exposes show-latest for saved updates even while disconnected', async () => {
  const view = render(fixture());
  await act(async () => {});
  fireEvent.wheel(document.querySelector('.session-list-scroll')!);
  refresh();
  view.rerender(fixture());
  expect(order()).toEqual(['Preview Second conversation', 'Preview First conversation']);
  fireEvent.click(screen.getByRole('button', { name: /1 updated · show latest/ }));
  expect(order()).toEqual(['Preview First conversation', 'Preview Second conversation']);
});

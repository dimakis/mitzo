// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { Session, SessionActivity, SessionSearchResult } from '@mitzo/protocol';
import { SessionList } from '../SessionList';

const state = vi.hoisted(() => ({
  sessions: [] as Session[],
  activities: [] as SessionActivity[],
  lastKnownActivities: [] as SessionActivity[],
  connected: true,
  searchActive: false,
  results: [] as SessionSearchResult[],
}));
vi.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => ({
    sessions: state.sessions,
    quickActions: [],
    loading: false,
    hasMore: false,
    handleRename: vi.fn(),
    dismissSession: vi.fn(),
    retry: vi.fn(),
  }),
}));
vi.mock('../../hooks/useSessionOverview', () => ({
  useSessionOverview: () => ({ ...state, attendCount: 0 }),
}));
vi.mock('../../hooks/useSessionSearch', () => ({
  useSessionSearch: () => ({
    active: state.searchActive,
    query: 'Saved',
    results: state.results,
    searching: false,
    setQuery: vi.fn(),
    clear: vi.fn(),
  }),
}));
vi.mock('../../hooks/useMediaQuery', () => ({ useMediaQuery: () => true }));
vi.mock('../../components/SessionInspector', () => ({
  SessionInspector: ({ session }: { session: Session }) => (
    <output aria-label="Preview model">{session.model ?? 'Unknown'}</output>
  ),
}));
const activity = {
  sessionId: 'one',
  clientId: 'client',
  title: 'Saved chat',
  state: 'working' as const,
  flags: [],
  lastEventAt: 2,
};
const ui = () => (
  <MemoryRouter>
    <SessionList />
  </MemoryRouter>
);
beforeEach(() => {
  localStorage.clear();
  state.sessions = [
    { id: 'one', summary: 'Saved chat', lastModified: 1, model: 'Luna', modelObservedAt: 10 },
  ];
  state.activities = [];
  state.lastKnownActivities = [];
  state.connected = true;
  state.searchActive = false;
  state.results = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => [] })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('retains uncertainty for a search-only chat after its activity disappears', async () => {
  state.sessions = [];
  state.searchActive = true;
  state.results = [
    {
      sessionId: 'one',
      summary: 'Saved chat',
      snippet: 'Saved',
      matchedAt: 1,
      updatedAt: 1,
      model: 'Luna',
      modelObservedAt: 10,
    },
  ];
  const view = render(ui());
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Preview Saved chat' }));
  expect(screen.getByLabelText('Model: Luna')).toBeTruthy();
  state.activities = [{ ...activity, modelUnavailable: true, modelObservedAt: 20 }];
  view.rerender(ui());
  expect(screen.queryByLabelText('Model: Luna')).toBeNull();
  state.activities = [];
  state.lastKnownActivities = [];
  view.rerender(ui());
  expect(screen.queryByLabelText('Model: Luna')).toBeNull();
  expect(screen.getByLabelText('Preview model').textContent).toBe('Unknown');
});

it('clears list and open-preview caches on read failure, retains uncertainty offline, and recovers from fresh HTTP', async () => {
  const view = render(ui());
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Preview Saved chat' }));
  expect(screen.getByLabelText('Model: Luna')).toBeTruthy();
  expect(screen.getByLabelText('Preview model').textContent).toBe('Luna');
  const failed = { ...activity, modelUnavailable: true, modelObservedAt: 20 };
  state.activities = [failed];
  view.rerender(ui());
  expect(screen.queryByLabelText('Model: Luna')).toBeNull();
  expect(screen.getByLabelText('Preview model').textContent).toBe('Unknown');
  state.connected = false;
  state.lastKnownActivities = [failed];
  state.activities = [];
  view.rerender(ui());
  expect(screen.queryByLabelText('Model: Luna')).toBeNull();
  expect(screen.getByLabelText('Preview model').textContent).toBe('Unknown');
  state.connected = true;
  view.rerender(ui());
  expect(screen.queryByLabelText('Model: Luna')).toBeNull();
  expect(screen.getByLabelText('Preview model').textContent).toBe('Unknown');
  state.sessions = [{ ...state.sessions[0], model: 'Sol', modelObservedAt: 30 }];
  view.rerender(ui());
  expect(screen.getByLabelText('Model: Sol')).toBeTruthy();
  expect(screen.getByLabelText('Preview model').textContent).toBe('Sol');
});

it('uses fresh search failure over cached rows and fresh overview recovery over old search failure', async () => {
  state.searchActive = true;
  state.results = [
    {
      sessionId: 'one',
      summary: 'Saved chat',
      snippet: 'Saved',
      matchedAt: 1,
      updatedAt: 1,
      model: 'Luna',
      modelObservedAt: 10,
    },
  ];
  const view = render(ui());
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Preview Saved chat' }));
  expect(screen.getByLabelText('Model: Luna')).toBeTruthy();
  state.results = [
    { ...state.results[0], model: undefined, modelUnavailable: true, modelObservedAt: 20 },
  ];
  view.rerender(ui());
  expect(screen.queryByLabelText('Model: Luna')).toBeNull();
  expect(screen.getByLabelText('Preview model').textContent).toBe('Unknown');
  state.searchActive = false;
  state.results = [];
  view.rerender(ui());
  expect(screen.queryByLabelText('Model: Luna')).toBeNull();
  expect(screen.getByLabelText('Preview model').textContent).toBe('Unknown');
  state.activities = [{ ...activity, model: 'Sol', modelObservedAt: 30 }];
  view.rerender(ui());
  expect(screen.getByLabelText('Model: Sol')).toBeTruthy();
  expect(screen.getByLabelText('Preview model').textContent).toBe('Sol');
});

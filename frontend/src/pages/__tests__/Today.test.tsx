// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Today } from '../Today';
const data = vi.hoisted(() => ({
  sessions: [
    { id: 'session-1', summary: 'Resume investigation', lastModified: 1, totalTokens: 42000 },
  ],
  preferences: {
    revision: 1,
    names: { briefing: 'Jeeves', terminal: 'Minion' },
    pins: [{ kind: 'telos', id: 'goal-1', title: '# Canonical recovery\n\nLong body' }],
  },
  sessionsError: null as string | null,
  retrySessions: vi.fn(),
  query: '',
  setQuery: vi.fn(),
  briefing: null as { path: string; generatedAt: string } | null,
  fetchBriefing: (_url: string): Promise<unknown> => Promise.resolve(null),
}));
vi.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => ({
    sessions: data.sessions,
    loading: false,
    error: data.sessionsError,
    retry: data.retrySessions,
  }),
}));
vi.mock('../../hooks/useSessionSearch', () => ({
  useSessionSearch: () => ({
    query: data.query,
    setQuery: data.setQuery,
    results: [],
    searching: false,
    active: !!data.query,
    error: null,
    retry: vi.fn(),
  }),
}));
vi.mock('../../hooks/useAttentionFeed', () => ({
  useAttentionFeed: () => ({ items: [], loading: false }),
}));
vi.mock('../../lib/event-bus-singleton', () => ({ eventBus: { on: () => () => {} } }));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes('/preferences')
        ? data.preferences
        : url.includes('/quote')
          ? null
          : data.fetchBriefing(url),
  }),
}));
function show() {
  render(
    <MemoryRouter>
      <Today />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  localStorage.clear();
  data.briefing = null;
  data.sessionsError = null;
  data.query = '';
  data.setQuery.mockReset();
  data.retrySessions.mockReset();
  data.fetchBriefing = async () => data.briefing;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 8, 9));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('Today', () => {
  it('prioritizes compact session entry, labelled search and genuine Today pins', async () => {
    show();
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Today', level: 1 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'New session' }).getAttribute('href')).toBe('/chat');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search sessions and messages' }), {
      target: { value: 'recovery' },
    });
    expect(data.setQuery).toHaveBeenCalledWith('recovery');
    expect(screen.getByRole('link', { name: /Canonical recovery/ }).getAttribute('href')).toBe(
      '/todos/goal-1',
    );
    expect(screen.queryByText(/Long body/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Your focus' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add pin' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage pins' })).toBeTruthy();
  });
  it('opens the saved dated reader and named minion without regenerating', async () => {
    data.briefing = {
      path: '/workspace/briefings/morning.md',
      generatedAt: '2026-09-08T08:30:00.000Z',
    };
    show();
    await act(async () => {});
    expect(screen.getByRole('link', { name: 'Read briefing' }).getAttribute('href')).toBe(
      '/briefings/2026-09-08',
    );
    expect(screen.getByRole('link', { name: 'Ask Jeeves' }).getAttribute('href')).toBe(
      '/briefings/2026-09-08?ask=1',
    );
    expect(screen.queryByText('Prepare another')).toBeNull();
  });
  it('refreshes when the scheduled briefing arrives', async () => {
    show();
    await act(async () => {});
    expect(screen.getByText('No saved briefing for today yet.')).toBeTruthy();
    data.briefing = {
      path: '/workspace/briefings/morning.md',
      generatedAt: '2026-09-08T08:30:00.000Z',
    };
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole('link', { name: 'Read briefing' })).toBeTruthy();
  });
  it('keeps a newer briefing when an earlier refresh resolves later', async () => {
    let resolveFirst!: (value: unknown) => void;
    let requests = 0;
    data.fetchBriefing = () =>
      ++requests === 1
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve({ path: '/workspace/new.md', generatedAt: '2026-09-08T08:30:00.000Z' });
    show();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole('link', { name: 'Read briefing' })).toBeTruthy();
    await act(async () => {
      resolveFirst(null);
    });
    expect(screen.getByRole('link', { name: 'Read briefing' })).toBeTruthy();
  });
  it('clears yesterday while the new day refreshes', async () => {
    vi.setSystemTime(new Date(2026, 8, 8, 23, 59));
    data.briefing = { path: '/workspace/old.md', generatedAt: '2026-09-08T08:30:00.000Z' };
    show();
    await act(async () => {});
    data.fetchBriefing = (url) =>
      url.includes('2026-09-09') ? new Promise(() => {}) : Promise.resolve(data.briefing);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.queryByRole('link', { name: 'Read briefing' })).toBeNull();
  });
  it('resumes the same session and keeps tokens optional', async () => {
    show();
    await act(async () => {});
    expect(screen.queryByText(/42k tokens/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Show session tokens on Today'));
    expect(screen.getByText(/42k tokens/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Resume investigation/ }).getAttribute('href')).toBe(
      '/chat/session-1',
    );
  });
  it('shows retry on a session failure', async () => {
    data.sessionsError = 'Couldn’t load chats.';
    show();
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t load chats');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(data.retrySessions).toHaveBeenCalledOnce();
  });
});

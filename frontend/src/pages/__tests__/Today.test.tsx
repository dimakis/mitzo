// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Today } from '../Today';
const data = vi.hoisted(() => ({
  sessions: [
    {
      id: 'session-1',
      summary: 'Resume investigation',
      lastModified: Date.now(),
      totalTokens: 42000,
    },
  ],
  items: Array.from({ length: 5 }, (_, i) => ({
    id: `focus-${i}`,
    title: `Review ${i}`,
    source: 'atb',
    meta: 'Review requested',
    navigateTo: `/tasks?task=task-${i}`,
  })),
  loading: false,
  briefing: null as { path: string; generatedAt: string } | null,
}));
vi.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => ({ sessions: data.sessions, loading: data.loading }),
}));
vi.mock('../../hooks/useAttentionFeed', () => ({
  useAttentionFeed: () => ({ items: data.items, loading: data.loading }),
}));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(data.briefing) })),
}));
function Location() {
  return (
    <output data-testid="location">
      {useLocation().pathname}
      {useLocation().search}
    </output>
  );
}
function show() {
  render(
    <MemoryRouter>
      <Today />
      <Location />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  localStorage.clear();
  data.briefing = null;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 8, 9));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('Today', () => {
  it('shows at most three focus records and follows their actual targets', () => {
    show();
    const focus = screen.getByRole('region', { name: 'Your focus' });
    expect(
      within(focus)
        .getAllByRole('link')
        .filter((a) => a.getAttribute('href')?.startsWith('/tasks?')),
    ).toHaveLength(3);
    expect(screen.queryByText('Review 3')).toBeNull();
    fireEvent.click(screen.getByText('Review 0'));
    expect(screen.getByTestId('location').textContent).toBe('/tasks?task=task-0');
  });
  it('changes time labels locally and only starts a briefing on explicit action', () => {
    show();
    expect(screen.getByText('Start with what matters.')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Prepare my briefing' }));
    expect(screen.getByTestId('location').textContent).toContain('/chat?prompt=');
  });
  it('shows and opens a briefing already prepared today', async () => {
    data.briefing = {
      path: '/workspace/command_center/briefings/morning_2026-09-08_0830.md',
      generatedAt: '2026-09-08T08:30:00.000Z',
    };
    show();
    await act(async () => {});

    expect(screen.getByText(/Briefing prepared/)).toBeTruthy();
    const briefing = screen.getByRole('link', { name: 'Open briefing' });
    expect(briefing.getAttribute('href')).toContain('/files?path=');
    expect(briefing.getAttribute('href')).toContain('morning_2026-09-08_0830.md');
  });
  it('refreshes an already-open page after the scheduled briefing is saved', async () => {
    show();
    await act(async () => {});
    expect(screen.getByText('Sources haven’t been checked here yet.')).toBeTruthy();

    data.briefing = {
      path: '/workspace/command_center/briefings/morning_2026-09-08_0830.md',
      generatedAt: '2026-09-08T08:30:00.000Z',
    };
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByText(/Briefing prepared/)).toBeTruthy();
  });
  it('shows evening copy after 18:00', () => {
    vi.setSystemTime(new Date(2026, 8, 8, 22));
    show();
    expect(screen.getByText('A little clarity for tomorrow.')).toBeTruthy();
  });
  it('resumes the same session and keeps home tokens optional', () => {
    show();
    expect(screen.queryByText(/42k tokens/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Show session tokens on Today'));
    expect(screen.getByText(/42k tokens · session/)).toBeTruthy();
    fireEvent.click(screen.getByText('Resume investigation'));
    expect(screen.getByTestId('location').textContent).toBe('/chat/session-1');
  });
  it('passes the exact user prompt to the existing chat entry', () => {
    show();
    fireEvent.change(screen.getByLabelText('Ask Mitzo'), { target: { value: 'Review A & B?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    const url = new URL(screen.getByTestId('location').textContent!, 'http://localhost');
    expect(url.pathname).toBe('/chat');
    expect(url.searchParams.get('prompt')).toBe('Review A & B?');
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SessionActivity } from '@mitzo/protocol';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockFeed = {
  items: [] as SessionActivity[],
  counts: { all: 0, needsMe: 0, inProgress: 0, done: 0 },
  filter: 'needs_me' as const,
  setFilter: vi.fn(),
  connected: true,
};

vi.mock('../../hooks/useSessionFeed', () => ({
  useSessionFeed: () => mockFeed,
}));

import { SessionFeed } from '../SessionFeed';

function renderFeed() {
  return render(
    <MemoryRouter>
      <SessionFeed />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mockNavigate.mockClear();
  mockFeed.setFilter.mockClear();
});

function makeActivity(overrides: Partial<SessionActivity> = {}): SessionActivity {
  return {
    sessionId: 'sess-1',
    clientId: 'client-1',
    title: 'Test Session',
    state: 'working',
    flags: [],
    lastEventAt: Date.now(),
    ...overrides,
  };
}

describe('SessionFeed', () => {
  it('renders nothing when counts.all is 0', () => {
    mockFeed.counts = { all: 0, needsMe: 0, inProgress: 0, done: 0 };
    mockFeed.items = [];
    const { container } = renderFeed();
    expect(container.querySelector('.feed-section')).toBeNull();
  });

  it('renders filter chips with counts', () => {
    mockFeed.counts = { all: 5, needsMe: 2, inProgress: 2, done: 1 };
    mockFeed.items = [makeActivity()];
    renderFeed();
    expect(screen.getByText('All')).toBeTruthy();
    expect(screen.getByText('Needs me')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    const countBadges = screen.getAllByText('2');
    expect(countBadges.length).toBeGreaterThanOrEqual(1);
  });

  it('calls setFilter when a chip is tapped', () => {
    mockFeed.counts = { all: 3, needsMe: 1, inProgress: 1, done: 1 };
    mockFeed.items = [makeActivity()];
    renderFeed();
    fireEvent.click(screen.getByText('All'));
    expect(mockFeed.setFilter).toHaveBeenCalledWith('all');
  });

  it('navigates to session on card tap', () => {
    mockFeed.counts = { all: 1, needsMe: 0, inProgress: 1, done: 0 };
    mockFeed.items = [makeActivity({ sessionId: 'sess-abc' })];
    renderFeed();
    fireEvent.click(screen.getByText('Test Session'));
    expect(mockNavigate).toHaveBeenCalledWith('/chat/sess-abc');
  });

  it('shows message preview when available', () => {
    mockFeed.counts = { all: 1, needsMe: 0, inProgress: 1, done: 0 };
    mockFeed.items = [makeActivity({ lastMessagePreview: 'Here is the implementation plan...' })];
    renderFeed();
    expect(screen.getByText('Here is the implementation plan...')).toBeTruthy();
  });

  it('renders without preview gracefully', () => {
    mockFeed.counts = { all: 1, needsMe: 0, inProgress: 1, done: 0 };
    mockFeed.items = [makeActivity()];
    const { container } = renderFeed();
    expect(container.querySelector('.feed-card-preview')).toBeNull();
    expect(screen.getByText('Test Session')).toBeTruthy();
  });

  it('shows empty state text for needs_me filter', () => {
    mockFeed.counts = { all: 1, needsMe: 0, inProgress: 1, done: 0 };
    mockFeed.items = [];
    mockFeed.filter = 'needs_me';
    renderFeed();
    expect(screen.getByText('All clear')).toBeTruthy();
  });

  it('shows repo tag when present', () => {
    mockFeed.counts = { all: 1, needsMe: 0, inProgress: 1, done: 0 };
    mockFeed.items = [makeActivity({ repo: 'mitzo' })];
    renderFeed();
    expect(screen.getByText('mitzo:')).toBeTruthy();
  });
});

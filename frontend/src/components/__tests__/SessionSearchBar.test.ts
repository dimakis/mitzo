/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionSearchBar } from '../SessionSearchBar';
import type { SessionSearchResult } from '../../types/chat';

afterEach(() => {
  cleanup();
});

const mockResults: SessionSearchResult[] = [
  {
    sessionId: 'abc123',
    summary: 'Fix auth bug',
    snippet: '...looking at the auth middleware...',
    matchedAt: Date.now() - 3600_000,
    updatedAt: Date.now() - 3600_000,
  },
  {
    sessionId: 'def456',
    summary: null,
    snippet: '...deploy pipeline changes...',
    matchedAt: Date.now() - 86400_000,
    updatedAt: Date.now() - 86400_000,
  },
];

function renderBar(props: Partial<Parameters<typeof SessionSearchBar>[0]> = {}) {
  const defaults = {
    query: '',
    setQuery: vi.fn(),
    results: [] as SessionSearchResult[],
    searching: false,
    active: false,
    clear: vi.fn(),
    onSelectSession: vi.fn(),
  };
  return render(createElement(SessionSearchBar, { ...defaults, ...props }));
}

describe('SessionSearchBar', () => {
  it('renders search toggle button', () => {
    renderBar();
    expect(screen.getByTitle('Search sessions')).toBeTruthy();
  });

  it('shows input when toggle is clicked', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByTitle('Search sessions'));
    expect(screen.getByPlaceholderText('Search sessions...')).toBeTruthy();
  });

  it('calls setQuery on input change', async () => {
    const setQuery = vi.fn();
    const user = userEvent.setup();
    renderBar({ setQuery, active: false });
    // Open the search bar
    await user.click(screen.getByTitle('Search sessions'));
    await user.type(screen.getByPlaceholderText('Search sessions...'), 'auth');
    expect(setQuery).toHaveBeenCalled();
  });

  it('renders search results when active', () => {
    renderBar({ active: true, query: 'auth', results: mockResults });
    expect(screen.getByText('Fix auth bug')).toBeTruthy();
    expect(screen.getByText('Untitled session')).toBeTruthy();
  });

  it('shows snippet text in results', () => {
    renderBar({ active: true, query: 'auth', results: mockResults });
    expect(screen.getByText('...looking at the auth middleware...')).toBeTruthy();
  });

  it('calls onSelectSession and clear when result is clicked', async () => {
    const onSelectSession = vi.fn();
    const clear = vi.fn();
    const user = userEvent.setup();
    renderBar({ active: true, query: 'auth', results: mockResults, onSelectSession, clear });
    await user.click(screen.getByText('Fix auth bug'));
    expect(onSelectSession).toHaveBeenCalledWith('abc123');
    expect(clear).toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('Search sessions...')).toBeNull();
    expect(screen.getByTitle('Search sessions')).toBeTruthy();
  });

  it('shows searching indicator', () => {
    renderBar({ active: true, query: 'auth', searching: true });
    expect(screen.getByText('Searching...')).toBeTruthy();
  });

  it('shows no results message when active with empty results', () => {
    renderBar({ active: true, query: 'zzz', results: [], searching: false });
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('calls clear on close and reverts to toggle', async () => {
    const clear = vi.fn();
    const user = userEvent.setup();
    renderBar({ active: true, query: 'auth', results: mockResults, clear });
    await user.click(screen.getByTitle('Close search'));
    expect(clear).toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('Search sessions...')).toBeNull();
    expect(screen.getByTitle('Search sessions')).toBeTruthy();
  });

  it('reverts to toggle button when closed with no active query', async () => {
    const user = userEvent.setup();
    renderBar();
    // Open
    await user.click(screen.getByTitle('Search sessions'));
    expect(screen.getByPlaceholderText('Search sessions...')).toBeTruthy();
    // Close
    await user.click(screen.getByTitle('Close search'));
    expect(screen.queryByPlaceholderText('Search sessions...')).toBeNull();
    expect(screen.getByTitle('Search sessions')).toBeTruthy();
  });

  it('hides stale results while searching', () => {
    renderBar({ active: true, query: 'auth', results: mockResults, searching: true });
    expect(screen.getByText('Searching...')).toBeTruthy();
    expect(screen.queryByText('Fix auth bug')).toBeNull();
  });

  it('dismisses on Escape key', async () => {
    const clear = vi.fn();
    const user = userEvent.setup();
    renderBar({ active: true, query: 'auth', results: mockResults, clear });
    const input = screen.getByPlaceholderText('Search sessions...');
    await user.click(input);
    await user.keyboard('{Escape}');
    expect(clear).toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('Search sessions...')).toBeNull();
    expect(screen.getByTitle('Search sessions')).toBeTruthy();
  });

  it('syncs open state when active prop transitions to true', async () => {
    const { rerender } = render(
      createElement(SessionSearchBar, {
        query: '',
        setQuery: vi.fn(),
        results: [],
        searching: false,
        active: false,
        clear: vi.fn(),
        onSelectSession: vi.fn(),
      }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByTitle('Search sessions'));
    await user.click(screen.getByTitle('Close search'));
    expect(screen.getByTitle('Search sessions')).toBeTruthy();

    rerender(
      createElement(SessionSearchBar, {
        query: 'test',
        setQuery: vi.fn(),
        results: mockResults,
        searching: false,
        active: true,
        clear: vi.fn(),
        onSelectSession: vi.fn(),
      }),
    );
    expect(screen.getByPlaceholderText('Search sessions...')).toBeTruthy();
  });
});

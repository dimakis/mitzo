// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// Mock useSessionList before importing SessionPanel
vi.mock('../../hooks/useSessionList', () => ({
  useSessionList: vi.fn(),
}));

// Mock useSessionOverview to avoid EventSource dependency
vi.mock('../../hooks/useSessionOverview', () => ({
  useSessionOverview: vi.fn(() => ({
    activities: [],
    attendCount: 0,
    connected: false,
  })),
}));

import { SessionPanel } from '../SessionPanel';
import { useSessionList } from '../../hooks/useSessionList';

const mockUseSessionList = vi.mocked(useSessionList);

function makeDefaultReturn(overrides = {}) {
  return {
    sessions: [],
    quickActions: [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    updateAvailable: false,
    checking: false,
    dismissSession: vi.fn(),
    clearAll: vi.fn(),
    handleRename: vi.fn(),
    checkForUpdates: vi.fn(),
    loadMore: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mockUseSessionList.mockReturnValue(makeDefaultReturn());
  // Default to "All" view so session list tests work (the "Active" view
  // renders ActiveSessionsList which is tested separately).
  localStorage.setItem('mitzo-session-view-mode', 'all');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('SessionPanel', () => {
  it('renders new chat button', () => {
    render(
      <SessionPanel activeSessionId={undefined} onSelectSession={vi.fn()} onNewChat={vi.fn()} />,
    );
    expect(screen.getByText('New Chat')).toBeTruthy();
  });

  it('calls onNewChat when button clicked', () => {
    const onNewChat = vi.fn();
    render(
      <SessionPanel activeSessionId={undefined} onSelectSession={vi.fn()} onNewChat={onNewChat} />,
    );
    fireEvent.click(screen.getByText('New Chat'));
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it('renders session list', () => {
    mockUseSessionList.mockReturnValue(
      makeDefaultReturn({
        sessions: [
          { id: 's1', summary: 'First session', lastModified: Date.now() },
          { id: 's2', summary: 'Second session', lastModified: Date.now() },
        ],
      }),
    );
    render(
      <SessionPanel activeSessionId={undefined} onSelectSession={vi.fn()} onNewChat={vi.fn()} />,
    );
    expect(screen.getByText('First session')).toBeTruthy();
    expect(screen.getByText('Second session')).toBeTruthy();
  });

  it('highlights active session', () => {
    mockUseSessionList.mockReturnValue(
      makeDefaultReturn({
        sessions: [{ id: 's1', summary: 'Active one', lastModified: Date.now() }],
      }),
    );
    const { container } = render(
      <SessionPanel activeSessionId="s1" onSelectSession={vi.fn()} onNewChat={vi.fn()} />,
    );
    const activeItem = container.querySelector('.session-panel-item--active');
    expect(activeItem).toBeTruthy();
  });

  it('calls onSelectSession when session clicked', () => {
    mockUseSessionList.mockReturnValue(
      makeDefaultReturn({
        sessions: [{ id: 's1', summary: 'Click me', lastModified: Date.now() }],
      }),
    );
    const onSelect = vi.fn();
    render(
      <SessionPanel activeSessionId={undefined} onSelectSession={onSelect} onNewChat={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('Click me'));
    expect(onSelect).toHaveBeenCalledWith('s1');
  });

  it('shows loading state', () => {
    mockUseSessionList.mockReturnValue(makeDefaultReturn({ loading: true }));
    render(
      <SessionPanel activeSessionId={undefined} onSelectSession={vi.fn()} onNewChat={vi.fn()} />,
    );
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('shows empty state when no sessions', () => {
    render(
      <SessionPanel activeSessionId={undefined} onSelectSession={vi.fn()} onNewChat={vi.fn()} />,
    );
    expect(screen.getByText('No sessions')).toBeTruthy();
  });

  it('shows delete button on hover (via class)', () => {
    mockUseSessionList.mockReturnValue(
      makeDefaultReturn({
        sessions: [{ id: 's1', summary: 'Hoverable', lastModified: Date.now() }],
      }),
    );
    const { container } = render(
      <SessionPanel activeSessionId={undefined} onSelectSession={vi.fn()} onNewChat={vi.fn()} />,
    );
    // Delete button exists in DOM but shown via CSS :hover
    const deleteBtn = container.querySelector('.session-panel-delete');
    expect(deleteBtn).toBeTruthy();
  });

  it('calls dismissSession when delete clicked', () => {
    const dismiss = vi.fn();
    mockUseSessionList.mockReturnValue(
      makeDefaultReturn({
        sessions: [{ id: 's1', summary: 'Delete me', lastModified: Date.now() }],
        dismissSession: dismiss,
      }),
    );
    const { container } = render(
      <SessionPanel activeSessionId={undefined} onSelectSession={vi.fn()} onNewChat={vi.fn()} />,
    );
    const deleteBtn = container.querySelector('.session-panel-delete')!;
    fireEvent.click(deleteBtn);
    expect(dismiss).toHaveBeenCalledWith('s1');
  });

  describe('Load More button', () => {
    it('renders when hasMore is true', () => {
      mockUseSessionList.mockReturnValue(
        makeDefaultReturn({
          sessions: [{ id: 's1', summary: 'A session', lastModified: Date.now() }],
          hasMore: true,
        }),
      );
      render(
        <SessionPanel activeSessionId={undefined} onSelectSession={vi.fn()} onNewChat={vi.fn()} />,
      );
      expect(screen.getByText('Load More')).toBeTruthy();
    });

    it('shows disabled loading state when loadingMore is true', () => {
      mockUseSessionList.mockReturnValue(
        makeDefaultReturn({
          sessions: [{ id: 's1', summary: 'A session', lastModified: Date.now() }],
          hasMore: true,
          loadingMore: true,
        }),
      );
      render(
        <SessionPanel activeSessionId={undefined} onSelectSession={vi.fn()} onNewChat={vi.fn()} />,
      );
      const btn = screen.getByText('Loading...');
      expect(btn).toBeTruthy();
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    });

    it('calls loadMore when clicked', () => {
      const loadMore = vi.fn();
      mockUseSessionList.mockReturnValue(
        makeDefaultReturn({
          sessions: [{ id: 's1', summary: 'A session', lastModified: Date.now() }],
          hasMore: true,
          loadMore,
        }),
      );
      render(
        <SessionPanel activeSessionId={undefined} onSelectSession={vi.fn()} onNewChat={vi.fn()} />,
      );
      fireEvent.click(screen.getByText('Load More'));
      expect(loadMore).toHaveBeenCalledOnce();
    });
  });
});

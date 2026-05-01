// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SessionActivity } from '../../hooks/useSessionOverview';

// Mock navigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await import('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// Mock haptics
vi.mock('../../lib/haptics', () => ({
  selectionChanged: vi.fn(),
}));

// Mock the hook
const mockActivities: SessionActivity[] = [];
let mockAttendCount = 0;

vi.mock('../../hooks/useSessionOverview', () => ({
  useSessionOverview: () => ({
    activities: mockActivities,
    attendCount: mockAttendCount,
    connected: true,
  }),
}));

import { SessionOverview } from '../SessionOverview';

afterEach(() => {
  cleanup();
  mockNavigate.mockClear();
  mockActivities.length = 0;
  mockAttendCount = 0;
});

function renderOverview() {
  return render(
    <MemoryRouter>
      <SessionOverview />
    </MemoryRouter>,
  );
}

function makeActivity(overrides: Partial<SessionActivity> = {}): SessionActivity {
  return {
    sessionId: 'session-1',
    clientId: 'client-1',
    title: 'Test Session',
    state: 'working',
    flags: [],
    lastEventAt: Date.now(),
    ...overrides,
  };
}

describe('SessionOverview', () => {
  it('renders nothing when no interesting sessions', () => {
    const { container } = renderOverview();
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when only idle/init sessions', () => {
    mockActivities.push(
      makeActivity({ state: 'idle' }),
      makeActivity({ sessionId: 's2', state: 'init' }),
    );
    const { container } = renderOverview();
    expect(container.innerHTML).toBe('');
  });

  it('renders header with summary when working sessions exist', () => {
    mockActivities.push(makeActivity({ state: 'working' }));
    renderOverview();
    expect(screen.getByText('Active Sessions')).toBeTruthy();
    expect(screen.getByText('1 working')).toBeTruthy();
  });

  it('shows badge when waiting sessions exist', () => {
    mockActivities.push(makeActivity({ state: 'waiting', waitReason: 'permission' }));
    mockAttendCount = 1;
    renderOverview();
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('auto-expands when attend count > 0', () => {
    mockActivities.push(makeActivity({ state: 'waiting' }));
    mockAttendCount = 1;
    renderOverview();
    // Cards should be visible
    expect(screen.getByText('Test Session')).toBeTruthy();
  });

  it('navigates on card tap', () => {
    mockActivities.push(makeActivity({ state: 'working' }));
    mockAttendCount = 1; // auto-expand
    renderOverview();

    const card = screen.getByText('Test Session').closest('button');
    fireEvent.click(card!);
    expect(mockNavigate).toHaveBeenCalledWith('/chat/session-1');
  });

  it('shows repo prefix in card title', () => {
    mockActivities.push(makeActivity({ state: 'working', repo: 'mitzo' }));
    mockAttendCount = 1;
    renderOverview();
    expect(screen.getByText('mitzo:')).toBeTruthy();
  });

  it('shows progress in card meta', () => {
    mockActivities.push(makeActivity({ state: 'working', progress: { done: 3, total: 7 } }));
    mockAttendCount = 1;
    renderOverview();
    // The meta text should contain progress
    const meta = document.querySelector('.overview-card-meta');
    expect(meta?.textContent).toContain('3/7');
  });

  it('toggles expansion on header click', () => {
    mockActivities.push(makeActivity({ state: 'working' }));
    // No attend count, so starts collapsed
    mockAttendCount = 0;
    renderOverview();

    // Should be collapsed initially (no card visible)
    expect(screen.queryByText('Test Session')).toBeNull();

    // Click header to expand
    fireEvent.click(screen.getByText('Active Sessions'));
    expect(screen.getByText('Test Session')).toBeTruthy();

    // Click again to collapse
    fireEvent.click(screen.getByText('Active Sessions'));
    expect(screen.queryByText('Test Session')).toBeNull();
  });
});

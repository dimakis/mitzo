// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../hooks/useTabBadges', () => ({
  useTabBadges: () => ({ inboxCount: 3, todoCount: 0 }),
}));

vi.mock('../../hooks/useMediaQuery', () => ({
  useIsDesktop: () => false,
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { TabBar } from '../TabBar';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  mockNavigate.mockClear();
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TabBar />
    </MemoryRouter>,
  );
}

describe('TabBar', () => {
  it('renders five tab items', () => {
    renderAt('/');
    const tabs = screen.getAllByRole('button');
    expect(tabs.length).toBe(5);
  });

  it('shows tab labels', () => {
    renderAt('/');
    expect(screen.getByText('Chat')).toBeTruthy();
    expect(screen.getByText('Calendar')).toBeTruthy();
    expect(screen.getByText('Inbox')).toBeTruthy();
    expect(screen.getByText('Telos')).toBeTruthy();
    expect(screen.getByText('More')).toBeTruthy();
  });

  it('highlights Chat tab on home route', () => {
    renderAt('/');
    const chatTab = screen.getByText('Chat').closest('button');
    expect(chatTab?.className).toContain('tab-bar-item--active');
  });

  it('highlights More tab on /tasks route', () => {
    renderAt('/tasks');
    const moreTab = screen.getByText('More').closest('button');
    expect(moreTab?.className).toContain('tab-bar-item--active');
  });

  it('shows badge on Inbox tab when count > 0', () => {
    renderAt('/');
    const badge = screen.getByText('3');
    expect(badge.className).toContain('tab-bar-badge');
  });

  it('does not show badge on Telos tab when count is 0', () => {
    renderAt('/');
    const todosTab = screen.getByText('Telos').closest('button');
    expect(todosTab?.querySelector('.tab-bar-badge')).toBeNull();
  });

  it('navigates when tab is clicked', () => {
    renderAt('/');
    fireEvent.click(screen.getByText('Calendar'));
    expect(mockNavigate).toHaveBeenCalledWith('/calendar');
  });

  it('uses the tab-bar CSS class', () => {
    const { container } = renderAt('/');
    expect(container.querySelector('.tab-bar')).toBeTruthy();
  });
});

// Desktop rendering is guarded by useIsDesktop() in TabBar.
// Verified via the useIsDesktop mock returning false above — if it returned true,
// all tests would fail because the component wouldn't render.

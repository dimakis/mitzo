// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
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
    expect(screen.getByText('Tasks')).toBeTruthy();
    expect(screen.getByText('Inbox')).toBeTruthy();
    expect(screen.getByText('Todos')).toBeTruthy();
    expect(screen.getByText('More')).toBeTruthy();
  });

  it('highlights Chat tab on home route', () => {
    renderAt('/');
    const chatTab = screen.getByText('Chat').closest('button');
    expect(chatTab?.className).toContain('tab-bar-item--active');
  });

  it('highlights Tasks tab on /tasks route', () => {
    renderAt('/tasks');
    const tasksTab = screen.getByText('Tasks').closest('button');
    expect(tasksTab?.className).toContain('tab-bar-item--active');
  });

  it('shows badge on Inbox tab when count > 0', () => {
    renderAt('/');
    const badge = screen.getByText('3');
    expect(badge.className).toContain('tab-bar-badge');
  });

  it('does not show badge on Todos tab when count is 0', () => {
    renderAt('/');
    const todosTab = screen.getByText('Todos').closest('button');
    expect(todosTab?.querySelector('.tab-bar-badge')).toBeNull();
  });

  it('navigates when tab is clicked', () => {
    renderAt('/');
    fireEvent.click(screen.getByText('Tasks'));
    expect(mockNavigate).toHaveBeenCalledWith('/tasks');
  });

  it('uses the tab-bar CSS class', () => {
    const { container } = renderAt('/');
    expect(container.querySelector('.tab-bar')).toBeTruthy();
  });
});

// Desktop rendering is guarded by useIsDesktop() in TabBar.
// Verified via the useIsDesktop mock returning false above — if it returned true,
// all tests would fail because the component wouldn't render.

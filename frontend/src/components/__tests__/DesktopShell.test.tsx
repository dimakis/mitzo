// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('../DesktopNav', () => ({
  DesktopNav: () => <nav data-testid="desktop-nav">Nav</nav>,
}));

import { DesktopShell } from '../DesktopShell';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => cleanup());

describe('DesktopShell', () => {
  it('renders all three panels', () => {
    render(
      <DesktopShell
        left={<div>Left Panel</div>}
        center={<div>Center Panel</div>}
        right={<div>Right Panel</div>}
      />,
    );
    expect(screen.getByText('Left Panel')).toBeTruthy();
    expect(screen.getByText('Center Panel')).toBeTruthy();
    expect(screen.getByText('Right Panel')).toBeTruthy();
  });

  it('collapses left sidebar and hides content', () => {
    render(
      <DesktopShell
        left={<div>Left Panel</div>}
        center={<div>Center</div>}
        right={<div>Right</div>}
      />,
    );
    const toggleBtn = screen.getByTitle('Hide sidebar');
    fireEvent.click(toggleBtn);
    expect(screen.queryByText('Left Panel')).toBeNull();
    expect(localStorage.getItem('mitzo-sidebar-left-collapsed')).toBe('1');
  });

  it('collapses right sidebar and hides content', () => {
    render(
      <DesktopShell
        left={<div>Left</div>}
        center={<div>Center</div>}
        right={<div>Right Panel</div>}
      />,
    );
    const toggleBtn = screen.getByTitle('Hide context');
    fireEvent.click(toggleBtn);
    expect(screen.queryByText('Right Panel')).toBeNull();
    expect(localStorage.getItem('mitzo-sidebar-right-collapsed')).toBe('1');
  });

  it('restores collapsed state from localStorage', () => {
    localStorage.setItem('mitzo-sidebar-left-collapsed', '1');
    render(
      <DesktopShell
        left={<div>Left Panel</div>}
        center={<div>Center</div>}
        right={<div>Right</div>}
      />,
    );
    expect(screen.queryByText('Left Panel')).toBeNull();
    expect(screen.getByTitle('Show sidebar')).toBeTruthy();
  });

  it('expands collapsed sidebar on toggle', () => {
    localStorage.setItem('mitzo-sidebar-left-collapsed', '1');
    render(
      <DesktopShell
        left={<div>Left Panel</div>}
        center={<div>Center</div>}
        right={<div>Right</div>}
      />,
    );
    fireEvent.click(screen.getByTitle('Show sidebar'));
    expect(screen.getByText('Left Panel')).toBeTruthy();
    expect(localStorage.getItem('mitzo-sidebar-left-collapsed')).toBe('0');
  });

  it('renders status bar when provided', () => {
    render(
      <DesktopShell
        left={<div>L</div>}
        center={<div>C</div>}
        right={<div>R</div>}
        statusBar={<div>Status Info</div>}
      />,
    );
    expect(screen.getByText('Status Info')).toBeTruthy();
  });

  it('does not render status row when statusBar is absent', () => {
    const { container } = render(
      <DesktopShell left={<div>L</div>} center={<div>C</div>} right={<div>R</div>} />,
    );
    expect(container.querySelector('.desktop-status-row')).toBeNull();
  });
});

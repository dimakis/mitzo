// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { PermissionBanner } from '../PermissionBanner';

const defaultProps = {
  permId: 'p1',
  toolName: 'Bash',
  toolInput: 'echo hello',
  onRespond: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PermissionBanner', () => {
  it('renders tier badge with correct class for elevated tier', () => {
    const { container } = render(<PermissionBanner {...defaultProps} tier="elevated" />);
    expect(container.querySelector('.perm-banner--elevated')).toBeTruthy();
    expect(screen.getByText('Shell Access')).toBeTruthy();
  });

  it('shows title when provided, falls back to toolName', () => {
    render(<PermissionBanner {...defaultProps} title="Custom Title" />);
    expect(screen.getByText('Custom Title')).toBeTruthy();
  });

  it('falls back to displayName then toolName', () => {
    render(<PermissionBanner {...defaultProps} displayName="Display Name" />);
    expect(screen.getByText('Display Name')).toBeTruthy();
  });

  it('Allow Once calls onRespond with correct args', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner {...defaultProps} onRespond={onRespond} />);
    fireEvent.click(screen.getByText('Allow Once'));
    expect(onRespond).toHaveBeenCalledWith('p1', 'once', 'Bash');
  });

  it('Always Allow calls onRespond with correct args', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner {...defaultProps} onRespond={onRespond} />);
    fireEvent.click(screen.getByText('Always Allow'));
    expect(onRespond).toHaveBeenCalledWith('p1', 'always', 'Bash');
  });

  it('Deny calls onRespond with deny', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner {...defaultProps} onRespond={onRespond} />);
    fireEvent.click(screen.getByText('Deny'));
    expect(onRespond).toHaveBeenCalledWith('p1', 'deny', 'Bash');
  });

  it('auto-deny fires when timer reaches 0', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner {...defaultProps} onRespond={onRespond} />);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(onRespond).toHaveBeenCalledWith('p1', 'deny', 'Bash');
  });
});

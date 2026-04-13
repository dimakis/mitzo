// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StatusBar } from '../StatusBar';

afterEach(() => cleanup());

describe('StatusBar', () => {
  it('renders connected state', () => {
    const { container } = render(<StatusBar connected={true} />);
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(container.querySelector('.status-dot--on')).toBeTruthy();
  });

  it('renders disconnected state', () => {
    const { container } = render(<StatusBar connected={false} />);
    expect(screen.getByText('Disconnected')).toBeTruthy();
    expect(container.querySelector('.status-dot--off')).toBeTruthy();
  });

  it('renders session ID truncated', () => {
    render(<StatusBar connected={true} sessionId="abcdef1234567890" />);
    expect(screen.getByText('abcdef123456')).toBeTruthy();
  });

  it('does not render session ID when absent', () => {
    const { container } = render(<StatusBar connected={true} />);
    expect(container.querySelector('.status-session')).toBeNull();
  });

  it('renders branch name', () => {
    render(<StatusBar connected={true} branch="feat/desktop-ui" />);
    expect(screen.getByText('feat/desktop-ui')).toBeTruthy();
  });

  it('renders session hash badge when in worktree with wtId', () => {
    render(
      <StatusBar
        connected={true}
        branch="session/2026-04-13-a3f2b1"
        isWorktree={true}
        wtId="2026-04-13-a3f2b1"
      />,
    );
    expect(screen.getByText('a3f2b1')).toBeTruthy();
  });

  it('does not render session hash badge when not worktree', () => {
    const { container } = render(<StatusBar connected={true} branch="main" isWorktree={false} />);
    expect(container.querySelector('.status-wt-badge')).toBeNull();
  });
});

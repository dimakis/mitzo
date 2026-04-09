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

  it('renders worktree badge when isWorktree', () => {
    render(<StatusBar connected={true} branch="wt-branch" isWorktree={true} />);
    expect(screen.getByText('WT')).toBeTruthy();
  });

  it('does not render worktree badge when not worktree', () => {
    render(<StatusBar connected={true} branch="main" isWorktree={false} />);
    expect(screen.queryByText('WT')).toBeNull();
  });
});

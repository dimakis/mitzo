// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WorkspaceControls } from '../WorkspaceControls';
import { DesktopShell } from '../DesktopShell';
import { ChatInput } from '../ChatInput';
import { StatusBar } from '../StatusBar';

vi.mock('../SlashPicker', () => ({ SlashPicker: () => <div>Available commands</div> }));
vi.mock('../SessionTray', () => ({ SessionTray: () => null }));
beforeEach(() => localStorage.clear());
afterEach(cleanup);

it('collapses workspace settings without unmounting the account controls and remembers preference', () => {
  const { unmount } = render(
    <WorkspaceControls status="Ready">
      <input aria-label="Account" defaultValue="Personal" />
    </WorkspaceControls>,
  );
  const toggle = screen.getByRole('button', { name: /Workspace/ });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Work' } });
  fireEvent.click(toggle);
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(toggle);
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Work');
  unmount();
  render(
    <WorkspaceControls status="Ready">
      <input aria-label="Account" />
    </WorkspaceControls>,
  );
  expect(screen.getByRole('button', { name: /Workspace/ }).getAttribute('aria-expanded')).toBe(
    'true',
  );
});

it('collapses the main navigation independently and keeps named destinations accessible', () => {
  const { unmount, container } = render(
    <MemoryRouter>
      <DesktopShell left={<p>Conversations</p>} center={<p>Messages</p>} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
  expect(container.querySelector('.workspace-rail--collapsed')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Chats' })).toBeTruthy();
  expect(screen.getByText('Conversations')).toBeTruthy();
  unmount();
  render(
    <MemoryRouter>
      <DesktopShell center={<p>Messages</p>} />
    </MemoryRouter>,
  );
  expect(
    screen.getByRole('button', { name: 'Expand navigation' }).getAttribute('aria-expanded'),
  ).toBe('false');
});

it('opens the named command picker without destroying a draft', () => {
  render(<ChatInput onSend={() => true} onStop={vi.fn()} running={false} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Keep this draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Commands' }));
  expect(screen.getByText('Available commands')).toBeTruthy();
  expect((input as HTMLTextAreaElement).value).toBe('Keep this draft');
});

it('keeps the command action named while allowing its desktop label to collapse on mobile', () => {
  const { container } = render(<ChatInput onSend={() => true} onStop={vi.fn()} running={false} />);
  expect(screen.getByRole('button', { name: 'Commands' })).toBeTruthy();
  expect(container.querySelector('.chat-input-command-label')?.textContent).toBe('Commands');
});

it('labels the stop action and preserves its behavior', () => {
  const stop = vi.fn();
  render(<ChatInput onSend={() => true} onStop={stop} running />);
  fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }));
  expect(stop).toHaveBeenCalledOnce();
});

it('puts technical IDs behind session details with a meaningful workspace summary', () => {
  render(
    <StatusBar
      connected
      sessionId="abcdef1234567890"
      branch="session/2026-09-08-123abc"
      wtId="123abc"
      isWorktree
    />,
  );
  expect(screen.getByText('Isolated workspace')).toBeTruthy();
  expect(screen.queryByText('abcdef123456')).toBeNull();
  fireEvent.click(screen.getByText('Session details'));
  expect(screen.getByText('abcdef1234567890')).toBeTruthy();
  expect(screen.getByText('session/2026-09-08-123abc')).toBeTruthy();
});

// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ComposerTools } from '../ComposerTools';
import { MobileShell } from '../MobileShell';
vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: () => false }));
vi.mock('../NotificationProvider', () => ({ useNotifications: () => null }));
afterEach(cleanup);
it('opens the same terminal from the hidden composer menu, carrying chat context and a return link', () => {
  render(
    <MemoryRouter>
      <ComposerTools
        onCommands={vi.fn()}
        commandsExpanded={false}
        onAttach={vi.fn()}
        attachmentDisabled={false}
        onDismiss={vi.fn()}
        terminalHref="/terminal?sessionId=chat-a&returnTo=%2Fchat%2Fchat-a"
      />
    </MemoryRouter>,
  );
  const toggle = screen.getByRole('button', { name: 'More composer actions' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  expect(screen.getByRole('link', { name: 'Terminal' }).getAttribute('href')).toContain(
    'sessionId=chat-a',
  );
});
it('reuses the exact collection masthead and gives the chat-launched terminal its Chats tab', () => {
  render(
    <MemoryRouter initialEntries={['/terminal?sessionId=chat-a&returnTo=%2Fchat%2Fchat-a']}>
      <MobileShell>
        <main>Terminal body</main>
      </MobileShell>
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Search chats' }).closest('header')?.className).toBe(
    'mobile-workspace-masthead',
  );
  expect(screen.getByRole('link', { name: 'Chats' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('link', { name: 'More' }).getAttribute('aria-current')).toBeNull();
});

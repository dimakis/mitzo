// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../App';

vi.mock('../route-pages', () => {
  const names = [
    'SandboxesView',
    'TerminalView',
    'SettingsView',
    'DraftsView',
    'UpdatesView',
    'BackupsView',
    'NotificationsView',
    'SymposiumSavedReviewRecordPage',
    'Login',
    'Today',
    'QuoteView',
    'BriefingView',
    'MockupsView',
    'MoreView',
    'ConnectionSetupView',
    'ConnectionsRoute',
    'ConnectionsAccessView',
    'SessionList',
    'ResponsiveChatView',
    'KnowledgeLibrary',
    'AgentLibrary',
    'FileViewer',
    'UnifiedInboxView',
    'InboxRedirect',
    'CalendarView',
    'TodoWorkspace',
    'TaskBoard',
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      () => (
        <main>
          <input aria-label="Draft" />
          <button>
            <span>Ordinary action</span>
          </button>
          <p>Conversation background</p>
          <details>
            <summary>
              <span>Conversation provenance</span>
            </summary>
            <p>Recorded author and time</p>
          </details>
        </main>
      ),
    ]),
  );
});
vi.mock('../components/NotificationProvider', () => ({
  NotificationProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../components/MobileShell', () => ({
  MobileShell: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../components/DesktopShell', () => ({
  DesktopShell: ({ center }: { center: ReactNode }) => center,
}));
vi.mock('../components/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../hooks/useMediaQuery', () => ({ useIsDesktop: () => false }));
afterEach(cleanup);
it('retains keyboard focus on a native provenance summary through synthetic activation clicks', () => {
  render(<App />);
  const summary = screen.getByText('Conversation provenance').closest('summary')!;
  summary.focus();
  fireEvent.click(summary, { detail: 0 });
  expect(document.activeElement).toBe(summary);
  fireEvent.click(summary, { detail: 0 });
  expect(document.activeElement).toBe(summary);
  expect(summary.isConnected).toBe(true);
});
it('preserves ordinary action focus and still dismisses an editable keyboard from noninteractive background', () => {
  render(<App />);
  const action = screen.getByRole('button', { name: 'Ordinary action' });
  action.focus();
  fireEvent.click(screen.getByText('Ordinary action'), { detail: 0 });
  expect(document.activeElement).toBe(action);
  const input = screen.getByRole('textbox', { name: 'Draft' });
  input.focus();
  fireEvent.click(screen.getByText('Conversation background'));
  expect(document.activeElement).toBe(document.body);
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionPanel } from '../SessionPanel';
const mocks = vi.hoisted(() => ({ dismiss: vi.fn(async () => true) }));
vi.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => ({
    sessions: [{ id: 'c', summary: 'Finished work', lastModified: 1 }],
    loading: false,
    retry: vi.fn(),
    dismissSession: mocks.dismiss,
    hideSession: mocks.dismiss,
    handleRename: vi.fn(),
  }),
}));
vi.mock('../../hooks/useSessionOverview', () => ({
  useSessionOverview: () => ({
    activities: [],
    lastKnownActivities: [],
    attendCount: 0,
    connected: false,
  }),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});
it('offers hiding directly from sidebar actions without entering deletion review', async () => {
  localStorage.setItem('mitzo-session-view-mode', 'all');
  render(
    <SessionPanel onNewChat={vi.fn()} onSelectSession={vi.fn()} activeSessionId={undefined} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Finished work' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide conversation' }));
  expect(mocks.dismiss).toHaveBeenCalledWith('c');
});
it('makes hidden chats discoverable beside the sidebar filters', () => {
  render(
    <SessionPanel onNewChat={vi.fn()} onSelectSession={vi.fn()} activeSessionId={undefined} />,
  );
  expect(screen.getByRole('button', { name: 'Hidden chats' })).toBeTruthy();
});

it('retains an explicit failure when hiding is refused', async () => {
  mocks.dismiss.mockResolvedValueOnce(false);
  localStorage.setItem('mitzo-session-view-mode', 'all');
  render(
    <SessionPanel onNewChat={vi.fn()} onSelectSession={vi.fn()} activeSessionId={undefined} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Finished work' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide conversation' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Could not hide this conversation',
  );
});

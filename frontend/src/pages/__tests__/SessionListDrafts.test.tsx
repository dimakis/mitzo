// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionList } from '../SessionList';
import { createChatDraft, saveChatDraft } from '../../lib/chat-drafts';
vi.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => ({
    sessions: [],
    quickActions: [{ label: 'Deploy Mitzo', prompt: 'Deploy' }],
    loading: false,
    hasMore: false,
    updateAvailable: true,
    checking: false,
    checkForUpdates: vi.fn(),
    dismissSession: vi.fn(),
    clearAll: vi.fn(),
    handleRename: vi.fn(),
    loadMore: vi.fn(),
  }),
}));
vi.mock('../../hooks/useSessionOverview', () => ({
  useSessionOverview: () => ({ activities: [] }),
}));
vi.mock('../../hooks/useSessionSearch', () => ({
  useSessionSearch: () => ({ active: false, query: '', setQuery: vi.fn() }),
}));
vi.mock('../../lib/haptics', () => ({ selectionChanged: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it('shows a counted Drafts destination and removes update controls from Chats', () => {
  saveChatDraft({ ...createChatDraft(), text: 'Unsent thought' });
  render(
    <MemoryRouter>
      <SessionList />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: /Drafts/ }).getAttribute('href')).toBe(
    '/sessions/drafts',
  );
  expect(screen.queryByText('Update available — Deploy Mitzo')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Deploy Mitzo' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reload interface' })).toBeNull();
});

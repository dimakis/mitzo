// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SessionList } from '../SessionList';
import { SessionPanel } from '../../components/SessionPanel';
const sessions = [
  { id: 'one', summary: 'First conversation', lastModified: 1 },
  { id: 'two', summary: 'Second conversation', lastModified: 2 },
];
const rename = vi.fn(),
  dismiss = vi.fn();
vi.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => ({
    sessions,
    quickActions: [],
    loading: false,
    hasMore: false,
    handleRename: rename,
    dismissSession: dismiss,
    retry: vi.fn(),
  }),
}));
vi.mock('../../hooks/useSessionOverview', () => ({
  useSessionOverview: () => ({
    activities: [
      {
        sessionId: 'two',
        clientId: 'client',
        title: 'Second conversation',
        state: 'working',
        flags: [],
        lastEventAt: 2,
      },
    ],
    attendCount: 0,
  }),
}));
vi.mock('../../hooks/useSessionSearch', () => ({
  useSessionSearch: () => ({
    active: false,
    query: '',
    results: [],
    searching: false,
    setQuery: vi.fn(),
    clear: vi.fn(),
  }),
}));
vi.mock('../../hooks/useMediaQuery', () => ({
  useMediaQuery: () => true,
  useIsDesktop: () => true,
}));
vi.mock('../../hooks/useHomePreferences', () => ({
  useHomePreferences: () => ({
    preferences: { revision: 1, pins: [] },
    loading: false,
    saving: false,
    error: null,
    update: vi.fn(),
  }),
}));
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          messageId: 'm1',
          role: 'assistant',
          blocks: [{ blockType: 'text', content: 'Saved answer only' }],
        },
      ],
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('automatically previews the first desktop row, then right-click selects and opens actions without a redundant preview entry', async () => {
  render(
    <MemoryRouter>
      <SessionList />
    </MemoryRouter>,
  );
  await act(async () => {});
  const preview = screen.getByRole('complementary', { name: 'Conversation preview' });
  expect(within(preview).getByText('Saved answer only')).toBeTruthy();
  const second = screen.getByRole('button', { name: 'Preview Second conversation' });
  fireEvent.contextMenu(second, { clientX: 120, clientY: 180 });
  expect(screen.getByRole('menu', { name: 'Session actions' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Preview conversation' })).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Pin conversation' }));
  expect(screen.getByRole('region', { name: 'Pinned conversations' })).toBeTruthy();
  expect(within(preview).getByRole('heading', { name: 'Second conversation' })).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
});
it.each(['all', 'active'])(
  'adds the same context menu to the %s sidebar list',
  async (viewMode) => {
    localStorage.setItem('mitzo-session-view-mode', viewMode);
    const select = vi.fn();
    render(
      <MemoryRouter>
        <SessionPanel activeSessionId="one" onSelectSession={select} onNewChat={vi.fn()} />
      </MemoryRouter>,
    );
    const row = screen.getByText('Second conversation').closest('button')!;
    fireEvent.contextMenu(row, { clientX: 150, clientY: 200 });
    await act(async () => {});
    expect(screen.getByRole('menuitem', { name: 'Pin conversation' })).toBeTruthy();
    expect(select).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menu')).toBeTruthy();
  },
);

it('previews a saved pin outside the loaded page without navigating into its provider chat', async () => {
  localStorage.setItem(
    'mitzo-conversation-pins',
    JSON.stringify([{ id: 'older', summary: 'Older saved chat', lastModified: 1 }]),
  );
  render(
    <MemoryRouter>
      <SessionList />
    </MemoryRouter>,
  );
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Pinned conversations' })).getByRole('button', {
      name: /^Older saved chat/,
    }),
  );
  await act(async () => {});
  expect(
    within(screen.getByRole('complementary', { name: 'Conversation preview' })).getByRole(
      'heading',
      { name: 'Older saved chat' },
    ),
  ).toBeTruthy();
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import type { Session } from '@mitzo/protocol';
import { SessionList } from '../SessionList';

let desktop = false;
let sessions: Session[];
vi.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => ({ sessions, quickActions: [], loading: false, hasMore: false }),
}));
vi.mock('../../hooks/useSessionOverview', () => ({
  useSessionOverview: () => ({ activities: [] }),
}));
vi.mock('../../hooks/useMediaQuery', () => ({
  useMediaQuery: () => desktop,
  useIsDesktop: () => desktop,
}));
vi.mock('../../hooks/useSessionSearch', () => ({
  useSessionSearch: () => ({
    active: false,
    query: '',
    results: [],
    setQuery: vi.fn(),
    clear: vi.fn(),
  }),
}));
beforeEach(() => {
  localStorage.clear();
  sessions = [
    {
      id: 'original',
      summary: 'Same title',
      lastModified: 2,
      sharedConversation: {
        collaborationId: 'discussion',
        sourceConversationId: 'original',
        membershipRevision: 2,
        participantSessionIds: ['original', 'peer'],
        unavailableParticipantSessionIds: ['peer'],
      },
    },
    { id: 'unrelated', summary: 'Same title', lastModified: 1 },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => [] })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  'identifies the shared row and opens its exact original history (desktop: %s)',
  async (wide) => {
    desktop = wide;
    function Destination() {
      return <p>Opened {useParams().id}</p>;
    }
    render(
      <MemoryRouter initialEntries={['/sessions']}>
        <Routes>
          <Route path="/sessions" element={<SessionList />} />
          <Route path="/chat/:id" element={<Destination />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {});
    const marker = screen
      .getAllByText('Symposium · 2 agents')
      .find((node) => node.closest('.session-item-navigation'))!;
    const row = marker.closest('.session-item-navigation') as HTMLElement;
    expect(row).toBeTruthy();
    expect(within(row).getByText('1 unavailable')).toBeTruthy();
    if (!wide)
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/messages'))).toBe(
        false,
      );
    if (wide) {
      fireEvent.click(row);
      const preview = screen.getByRole('complementary', { name: 'Conversation preview' });
      fireEvent.click(within(preview).getByRole('button', { name: 'Open conversation' }));
    } else fireEvent.keyDown(row, { key: 'Enter' });
    expect(screen.getByText('Opened original')).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/peer/'))).toBe(false);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/conversation'))).toBe(
      false,
    );
  },
);

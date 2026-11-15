// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { SessionList } from '../SessionList';

vi.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => ({ sessions: [], quickActions: [], loading: false, hasMore: false }),
}));
vi.mock('../../hooks/useSessionOverview', () => ({
  useSessionOverview: () => ({ activities: [] }),
}));
vi.mock('../../hooks/useMediaQuery', () => ({
  useMediaQuery: () => true,
  useIsDesktop: () => true,
}));
vi.mock('../../hooks/useSessionSearch', () => ({
  useSessionSearch: () => ({
    active: true,
    query: 'participant only',
    searching: false,
    setQuery: vi.fn(),
    clear: vi.fn(),
    results: [
      {
        sessionId: 'other',
        summary: 'Other match',
        snippet: 'other',
        matchedAt: 40,
        updatedAt: 40,
      },
      {
        sessionId: 'source',
        summary: 'Original discussion',
        snippet: 'participant only',
        matchedAt: 30,
        updatedAt: 50,
        matchedSessionId: 'participant',
      },
    ],
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
          blocks: [{ blockType: 'text', content: 'Participant-only saved evidence' }],
        },
      ],
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('previews and opens the matching participant while retaining the desktop source row identity', async () => {
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
  fireEvent.click(screen.getByRole('button', { name: 'Preview Original discussion' }));
  await act(async () => {});
  const preview = screen.getByRole('complementary', { name: 'Conversation preview' });
  expect(within(preview).getByRole('heading', { name: 'Original discussion' })).toBeTruthy();
  expect(within(preview).getByText('Participant-only saved evidence')).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith('/api/sessions/participant/messages', expect.anything());
  expect(fetch).not.toHaveBeenCalledWith('/api/sessions/source/messages', expect.anything());
  expect(within(preview).getByText('source')).toBeTruthy();
  fireEvent.click(within(preview).getByRole('button', { name: 'Open conversation' }));
  expect(screen.getByText('Opened participant')).toBeTruthy();
});

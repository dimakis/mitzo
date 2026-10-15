// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SessionList } from '../SessionList';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
  AUTH_RESTORED_EVENT: 'mitzo:auth-restored',
}));
vi.mock('../../hooks/useSessionOverview', () => ({
  useSessionOverview: () => ({ activities: [], attendCount: 0 }),
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
vi.mock('../../hooks/useMediaQuery', () => ({ useMediaQuery: () => true }));
vi.mock('../../hooks/useHomePreferences', () => ({
  useHomePreferences: () => ({ preferences: { revision: 1, pins: [] }, update: vi.fn() }),
}));
beforeEach(() => {
  window.dispatchEvent(new Event('mitzo:auth-lost'));
  localStorage.clear();
  vi.mocked(apiFetch).mockReset();
});
afterEach(cleanup);
function show() {
  return render(
    <MemoryRouter>
      <SessionList />
    </MemoryRouter>,
  );
}
function preview() {
  return screen.getByRole('complementary', { name: 'Conversation preview' });
}
function fixture(deletion: Promise<Response>) {
  let sessions = [
    { id: 'first', summary: 'First conversation', lastModified: 1 },
    { id: 'second', summary: 'Second conversation', lastModified: 2 },
  ];
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'DELETE') {
      const response = await deletion;
      if (response.ok)
        sessions = url === '/api/sessions' ? [] : sessions.filter((s) => !url.endsWith(s.id));
      return response;
    }
    if (url === '/api/sessions') return Response.json({ sessions, hasMore: false });
    if (url.endsWith('/messages')) return Response.json([]);
    return Response.json({});
  });
}
it('removes a selected off-page preview after clearing history succeeds', async () => {
  fixture(Promise.resolve(Response.json({})));
  localStorage.setItem(
    'mitzo-conversation-pins',
    JSON.stringify([{ id: 'older', summary: 'Older saved chat', lastModified: 0 }]),
  );
  show();
  await screen.findByRole('button', { name: 'Preview First conversation' });
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Pinned conversations' })).getByRole('button', {
      name: /^Older saved chat/,
    }),
  );
  expect(within(preview()).getByRole('heading', { name: 'Older saved chat' })).toBeTruthy();
  fireEvent.click(screen.getByText('Clear conversation history'));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Preview First conversation' })).toBeNull(),
  );
  expect(screen.queryByRole('complementary', { name: 'Conversation preview' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Open conversation' })).toBeNull();
});
it.each([true, false])(
  'retains a selected preview until deletion is confirmed (success=%s)',
  async (ok) => {
    let finish!: (response: Response) => void;
    fixture(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    show();
    const first = await screen.findByRole('button', { name: 'Preview First conversation' });
    fireEvent.contextMenu(first);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete conversation' }));
    await act(async () => {});
    expect(within(preview()).getByRole('heading', { name: 'First conversation' })).toBeTruthy();
    await act(async () => finish(Response.json({}, { status: ok ? 200 : 503 })));
    expect(within(preview()).queryByRole('heading', { name: 'First conversation' }) !== null).toBe(
      !ok,
    );
  },
);
it('preserves an off-page preview when clearing history fails', async () => {
  fixture(Promise.resolve(Response.json({}, { status: 503 })));
  localStorage.setItem(
    'mitzo-conversation-pins',
    JSON.stringify([{ id: 'older', summary: 'Older saved chat', lastModified: 0 }]),
  );
  show();
  await screen.findByRole('button', { name: 'Preview First conversation' });
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Pinned conversations' })).getByRole('button', {
      name: /^Older saved chat/,
    }),
  );
  fireEvent.click(screen.getByText('Clear conversation history'));
  await act(async () => {});
  expect(within(preview()).getByRole('heading', { name: 'Older saved chat' })).toBeTruthy();
});

// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { StrictMode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SdkConversationImport } from '../SdkConversationImport';
import { SessionList } from '../../pages/SessionList';
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api-fetch')>()),
  apiFetch,
}));
vi.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => ({
    sessions: [],
    quickActions: [],
    loading: false,
    error: null,
    loadingMore: false,
    hasMore: false,
    updateAvailable: false,
    checking: false,
    dismissSession: vi.fn(),
    clearAll: vi.fn(),
    handleRename: vi.fn(),
    checkForUpdates: vi.fn(),
    loadMore: vi.fn(),
    retry: vi.fn(),
  }),
}));
vi.mock('../../hooks/useSessionSearch', () => ({
  useSessionSearch: () => ({
    query: '',
    active: false,
    results: [],
    setQuery: vi.fn(),
    clear: vi.fn(),
  }),
}));
vi.mock('../../hooks/useSessionOverview', () => ({
  useSessionOverview: () => ({ activities: [] }),
}));
vi.mock('../../lib/haptics', () => ({ selectionChanged: vi.fn() }));
afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});
it('imports a conversation only after explicit selection', async () => {
  apiFetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        candidates: [
          { id: 'cli', summary: 'CLI conversation', cwd: '/projects/repo', lastModified: 1 },
        ],
      }),
    ),
  );
  const imported = vi.fn();
  render(<SdkConversationImport onImported={imported} onClose={() => {}} />);
  await screen.findByText('CLI conversation');
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(imported).not.toHaveBeenCalled();
  apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'cli' })));
  fireEvent.click(screen.getByRole('button', { name: /Import CLI conversation/ }));
  await waitFor(() => expect(imported).toHaveBeenCalledWith('cli'));
  expect(apiFetch.mock.calls[1][0]).toBe('/api/sessions/import');
  expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toEqual({ sessionId: 'cli' });
});
it('keeps failed imports visible and never opens them', async () => {
  apiFetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ candidates: [{ id: 'cli', summary: 'CLI conversation', lastModified: 1 }] }),
    ),
  );
  const imported = vi.fn();
  render(<SdkConversationImport onImported={imported} onClose={() => {}} />);
  await screen.findByText('CLI conversation');
  apiFetch.mockResolvedValueOnce(new Response('{}', { status: 404 }));
  fireEvent.click(screen.getByRole('button', { name: /Import CLI conversation/ }));
  await screen.findByRole('alert');
  expect(imported).not.toHaveBeenCalled();
});

const candidateResponse = () =>
  new Response(
    JSON.stringify({
      candidates: [{ id: 'cli', summary: 'CLI conversation', lastModified: 1 }],
    }),
  );

it('rejects an import response naming a different conversation', async () => {
  apiFetch.mockResolvedValueOnce(candidateResponse());
  const imported = vi.fn();
  render(<SdkConversationImport onImported={imported} onClose={() => {}} />);
  await screen.findByText('CLI conversation');
  apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'other' })));
  fireEvent.click(screen.getByRole('button', { name: 'Import CLI conversation' }));
  await screen.findByRole('alert');
  expect(imported).not.toHaveBeenCalled();
});

it('cancels a pending import on close and ignores its late successful response', async () => {
  apiFetch.mockResolvedValueOnce(candidateResponse());
  const imported = vi.fn();
  const closed = vi.fn();
  render(<SdkConversationImport onImported={imported} onClose={closed} />);
  await screen.findByText('CLI conversation');
  let finish!: (response: Response) => void;
  apiFetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Import CLI conversation' }));
  expect(
    screen.getByRole('button', { name: 'Import CLI conversation' }).hasAttribute('disabled'),
  ).toBe(true);
  const signal = apiFetch.mock.calls[1][1].signal as AbortSignal;
  fireEvent.click(screen.getByRole('button', { name: 'Close import' }));
  expect(closed).toHaveBeenCalledOnce();
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish(new Response(JSON.stringify({ sessionId: 'cli' })));
  });
  expect(imported).not.toHaveBeenCalled();
});

it('cancels a pending import when the Chats page unmounts', async () => {
  apiFetch.mockResolvedValueOnce(candidateResponse());
  const imported = vi.fn();
  const view = render(<SdkConversationImport onImported={imported} onClose={() => {}} />);
  await screen.findByText('CLI conversation');
  let finish!: (response: Response) => void;
  apiFetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Import CLI conversation' }));
  const signal = apiFetch.mock.calls[1][1].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish(new Response(JSON.stringify({ sessionId: 'cli' })));
  });
  expect(imported).not.toHaveBeenCalled();
});

it('ignores a stale candidate request when StrictMode restarts discovery', async () => {
  let stale!: (response: Response) => void;
  apiFetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        stale = resolve;
      }),
  );
  apiFetch.mockResolvedValueOnce(candidateResponse());
  render(
    <StrictMode>
      <SdkConversationImport onImported={() => {}} onClose={() => {}} />
    </StrictMode>,
  );
  await screen.findByText('CLI conversation');
  await act(async () => {
    stale(
      new Response(
        JSON.stringify({ candidates: [{ id: 'stale', summary: 'Stale helper', lastModified: 1 }] }),
      ),
    );
  });
  expect(screen.queryByText('Stale helper')).toBeNull();
  expect(screen.getByText('CLI conversation')).toBeTruthy();
});

it('focuses the import heading and closes with Escape', () => {
  apiFetch.mockImplementationOnce(() => new Promise(() => {}));
  const closed = vi.fn();
  render(<SdkConversationImport onImported={() => {}} onClose={closed} />);
  expect(document.activeElement).toBe(
    screen.getByRole('heading', { name: 'Import a conversation' }),
  );
  fireEvent.keyDown(screen.getByRole('region', { name: 'Import external conversations' }), {
    key: 'Escape',
  });
  expect(closed).toHaveBeenCalledOnce();
});

function Location() {
  return <output aria-label="Current route">{useLocation().pathname}</output>;
}

it('keeps the import list inside the scroll area and restores focus when closed', async () => {
  apiFetch.mockResolvedValueOnce(candidateResponse());
  render(
    <MemoryRouter>
      <SessionList />
      <Location />
    </MemoryRouter>,
  );
  expect(apiFetch).not.toHaveBeenCalled();
  const options = screen.getByLabelText('Conversation options');
  fireEvent.click(options);
  fireEvent.click(screen.getByRole('button', { name: 'Import CLI conversation' }));
  await screen.findByText('CLI conversation');
  expect(
    screen
      .getByRole('region', { name: 'Import external conversations' })
      .closest('.session-list-scroll'),
  ).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close import' }));
  expect(document.activeElement).toBe(options);
  expect(screen.getByLabelText('Current route').textContent).toBe('/');
  fireEvent.click(screen.getByRole('button', { name: '+ New chat' }));
  expect(screen.getByLabelText('Current route').textContent).toBe('/chat');
});

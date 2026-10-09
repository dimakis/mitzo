// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../../lib/api-fetch';
import { FileViewer } from '../FileViewer';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../../hooks/useEditorViewport', () => ({ useEditorViewport: () => ({ current: null }) }));
vi.mock('../../hooks/useFileEditor', () => ({
  useFileEditor: () => ({ dirty: false, editing: false, saving: false, resetEditor: vi.fn() }),
}));
vi.mock('../../hooks/useDocumentReader', () => ({
  useDocumentReader: () => ({ available: false, state: 'idle' }),
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      ({
        ok: true,
        json: async () =>
          String(url).startsWith('/api/git/info')
            ? {
                branch: 'main',
                repoPath: '/repo',
                worktreesLoaded: String(url).includes('worktrees=1'),
                worktrees: String(url).includes('worktrees=1')
                  ? [
                      {
                        name: 'chat',
                        path: '/repo/.claude/worktrees/chat',
                        branch: 'session/chat',
                        age: 'unknown',
                      },
                    ]
                  : [],
              }
            : String(url) === '/api/files/roots'
              ? []
              : { entries: [], dir: '/repo', root: '/repo' },
      }) as never,
  );
});

it('offers an explicit worktree button and fetches choices only after activation', async () => {
  render(
    <MemoryRouter initialEntries={['/files']}>
      <FileViewer />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'Worktrees' })).toBeDefined());
  expect(apiFetch).not.toHaveBeenCalledWith('/api/git/info?worktrees=1');
  expect(screen.queryByRole('button', { name: 'session/chat' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Worktrees' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'session/chat' })).toBeDefined());
  expect(apiFetch).toHaveBeenCalledWith('/api/git/info?worktrees=1');
});

it('keeps the worktree button usable after incomplete discovery and shows recovered choices', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let attempts = 0;
  vi.mocked(apiFetch).mockImplementation((url) => {
    if (String(url).includes('worktrees=1') && ++attempts === 1)
      return Promise.resolve({
        ok: true,
        json: async () => ({
          branch: 'main',
          repoPath: '/repo',
          worktrees: [],
          worktreesLoaded: false,
        }),
      }) as never;
    return original(url);
  });
  render(
    <MemoryRouter initialEntries={['/files']}>
      <FileViewer />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Worktrees' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Worktrees' })).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: 'Worktrees' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'session/chat' })).toBeDefined());
  expect(attempts).toBe(2);
  expect(screen.queryByRole('button', { name: 'Worktrees' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

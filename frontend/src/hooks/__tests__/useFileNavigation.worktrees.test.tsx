// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileNavigation } from '../useFileNavigation';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
const response = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockImplementation((url) => {
    const path = String(url);
    if (path.startsWith('/api/git/info'))
      return response({
        branch: 'main',
        repoPath: '/repo',
        worktreesLoaded: path.includes('worktrees=1'),
        worktrees: path.includes('worktrees=1')
          ? [
              {
                name: 'chat',
                path: '/repo/.claude/worktrees/chat',
                branch: 'session/chat',
                age: 'unknown',
              },
            ]
          : [],
      }) as never;
    if (path === '/api/files/roots') return response([]) as never;
    if (path.startsWith('/api/files/read'))
      return response({ content: '# Report', ext: '.md' }) as never;
    return response({ entries: [], dir: '/repo', root: '/repo' }) as never;
  });
});

describe('lazy file navigation worktrees', () => {
  it('opens files independently and discovers worktrees only on request', async () => {
    const { result } = renderHook(() =>
      useFileNavigation(new URLSearchParams('path=outputs/report.md&sessionId=chat'), vi.fn()),
    );
    await waitFor(() => expect(result.current.state.content).toBe('# Report'));
    expect(apiFetch).not.toHaveBeenCalledWith('/api/git/info?worktrees=1');
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/files/read?path=outputs%2Freport.md&sessionId=chat',
    );
    await act(() => result.current.loadWorktrees());
    expect(result.current.state.gitInfo?.worktrees).toHaveLength(1);
    await act(() => result.current.loadWorktrees());
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([url]) => url === '/api/git/info?worktrees=1'),
    ).toHaveLength(1);
    expect(result.current.state.activeRoot).toBe('');
  });

  it('retains an explicit worktree root while discovering available worktrees', async () => {
    const setParams = vi.fn();
    const root = '/repo/.claude/worktrees/chat';
    const { result } = renderHook(() =>
      useFileNavigation(new URLSearchParams({ root, sessionId: 'chat' }), setParams),
    );
    await waitFor(() => expect(result.current.state.loading).toBe(false));
    await act(() => result.current.loadWorktrees());
    expect(result.current.state.activeRoot).toBe(root);
    act(() => result.current.handleRootChange('/secondary', false));
    expect(setParams).toHaveBeenCalledWith({ root: '/secondary', sessionId: 'chat' });
  });

  it('shows worktree errors and allows another request', async () => {
    const original = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation((url) =>
      String(url).includes('worktrees=1')
        ? (Promise.resolve({ ok: false, json: async () => ({}) }) as never)
        : original(url),
    );
    const { result } = renderHook(() => useFileNavigation(new URLSearchParams(), vi.fn()));
    await waitFor(() => expect(result.current.state.loading).toBe(false));
    await act(() => result.current.loadWorktrees());
    expect(result.current.state.worktreesError).toBe('Failed to load worktrees');
    expect(result.current.state.error).toBe('');
    await act(() => result.current.loadWorktrees());
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([url]) => url === '/api/git/info?worktrees=1'),
    ).toHaveLength(2);
  });
});

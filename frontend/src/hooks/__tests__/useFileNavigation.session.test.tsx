// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileNavigation } from '../useFileNavigation';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));

const response = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockImplementation((url) => {
    const path = String(url);
    if (path === '/api/git/info')
      return response({ branch: 'main', repoPath: '/base-repo', worktrees: [] }) as never;
    if (path === '/api/files/roots') return response([]) as never;
    if (path.startsWith('/api/files/read'))
      return response({ content: 'report', ext: '.html' }) as never;
    const dir = new URL(path, 'https://mitzo.test').searchParams.get('dir');
    return response({
      dir: dir ? (dir.startsWith('/') ? dir : `/session-workspace/${dir}`) : '/session-workspace',
      root: '/session-workspace',
      entries: [],
    }) as never;
  });
});

describe('useFileNavigation session root', () => {
  it('returns from a relative artifact to the session workspace', async () => {
    const { result } = renderHook(
      () => {
        const [params, setParams] = useSearchParams();
        return useFileNavigation(params, setParams);
      },
      {
        wrapper: ({ children }) => (
          <MemoryRouter initialEntries={['/files?path=report.html&sessionId=session-1']}>
            {children}
          </MemoryRouter>
        ),
      },
    );

    await waitFor(() => expect(result.current.state.gitInfo?.repoPath).toBe('/base-repo'));
    expect(result.current.state.activeRoot).toBe('');

    act(() => result.current.handleBack(false));
    await waitFor(() => {
      const directoryCall = vi
        .mocked(apiFetch)
        .mock.calls.find(([url]) => String(url).startsWith('/api/files?'));
      expect(directoryCall).toBeDefined();
      const params = new URL(directoryCall![0] as string, 'https://mitzo.test').searchParams;
      expect(params.get('sessionId')).toBe('session-1');
      expect(params.has('root')).toBe(false);
      expect(params.get('dir')).toBe('');
    });
    await waitFor(() => expect(result.current.state.canGoUp).toBe(false));
    const calls = vi.mocked(apiFetch).mock.calls.length;
    act(() => result.current.goUp(false));
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(calls);
  });

  it('allows upward navigation inside the workspace and stops at its root', async () => {
    const { result } = renderHook(
      () => {
        const [params, setParams] = useSearchParams();
        return useFileNavigation(params, setParams);
      },
      {
        wrapper: ({ children }) => (
          <MemoryRouter initialEntries={['/files?dir=outputs&sessionId=session-1']}>
            {children}
          </MemoryRouter>
        ),
      },
    );

    await waitFor(() => expect(result.current.state.canGoUp).toBe(true));
    act(() => result.current.goUp(false));
    await waitFor(() => expect(result.current.state.currentDir).toBe('/session-workspace'));
    expect(result.current.state.canGoUp).toBe(false);
  });
});

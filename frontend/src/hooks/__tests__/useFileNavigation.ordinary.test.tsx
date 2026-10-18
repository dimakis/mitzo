// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useFileNavigation } from '../useFileNavigation';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const id = '11111111-1111-4111-8111-111111111111';
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function fixture() {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const parsed = new URL(String(url), 'https://mitzo.test'),
      session = parsed.searchParams.get('sessionId') || 'global';
    if (parsed.pathname.endsWith('/meta'))
      return reply({ sessionId: parsed.pathname.split('/')[3], ordinaryWorkspaceId: id });
    if (parsed.pathname === '/api/files/roots')
      return reply([{ label: 'Conversation files', path: '/private/' + session }]);
    if (parsed.pathname === '/api/files/read')
      return reply({
        path: '/private/' + session + '/report.md',
        content: 'Report ' + session,
        ext: '.md',
      });
    if (parsed.pathname.startsWith('/api/git/'))
      return reply({
        branch: 'main',
        repoPath: '/configured-repo',
        worktrees: [],
        worktreesLoaded: false,
      });
    return reply({
      dir: '/private/' + session,
      root: '/private/' + session,
      entries: [{ name: 'report.md', isDir: false }],
    });
  });
}
it('discovers only the selected ordinary session roots and never loads Git/worktrees', async () => {
  fixture();
  const { result } = renderHook(() =>
    useFileNavigation(new URLSearchParams({ sessionId: 'ordinary-a' }), vi.fn()),
  );
  await waitFor(() =>
    expect(result.current.state.roots).toEqual([
      { label: 'Conversation files', path: '/private/ordinary-a' },
    ]),
  );
  await waitFor(() => expect(result.current.state.loading).toBe(false));
  expect(result.current.state.gitInfo).toBeNull();
  expect(result.current.state.canLoadWorktrees).toBe(false);
  await act(async () => result.current.loadWorktrees());
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).startsWith('/api/git/'))).toBe(
    false,
  );
  expect(apiFetch).toHaveBeenCalledWith('/api/files/roots?sessionId=ordinary-a');
  expect(result.current.state.currentDir).toBe('/private/ordinary-a');
});
it('hides the old roots and content synchronously on session navigation and ignores delayed responses', async () => {
  fixture();
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let finishB!: () => void;
  vi.mocked(apiFetch).mockImplementation((url, ...args) =>
    String(url).includes('/read') && String(url).includes('sessionId=b')
      ? new Promise((resolve) => {
          finishB = () =>
            resolve(reply({ path: '/private/b/report.md', content: 'Report b', ext: '.md' }));
        })
      : original(url, ...args),
  );
  const snapshots: { session: string; roots: unknown; content: string; git: unknown }[] = [];
  const { result, rerender } = renderHook(
    ({ session }) => {
      const nav = useFileNavigation(
        new URLSearchParams({ path: 'report.md', sessionId: session }),
        vi.fn(),
      );
      snapshots.push({
        session,
        roots: nav.state.roots,
        content: nav.state.content,
        git: nav.state.gitInfo,
      });
      return nav;
    },
    { initialProps: { session: 'a' } },
  );
  await waitFor(() => expect(result.current.state.content).toBe('Report a'));
  await waitFor(() => expect(result.current.state.roots[0]?.path).toBe('/private/a'));
  rerender({ session: 'b' });
  expect(snapshots.find((row) => row.session === 'b')).toEqual({
    session: 'b',
    roots: [],
    content: '',
    git: null,
  });
  await waitFor(() => expect(finishB).toBeDefined());
  await act(async () => finishB());
  expect(result.current.state.content).toBe('Report b');
  expect(result.current.state.filePath).toBe('/private/b/report.md');
  expect(result.current.state.roots[0]?.path).toBe('/private/b');
});
it('does not fall back to configured Git or roots when scoped metadata/readiness is unavailable', async () => {
  fixture();
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((url, ...args) =>
    String(url).endsWith('/meta')
      ? Promise.resolve(reply({ error: 'Unavailable' }, 503))
      : String(url).startsWith('/api/files')
        ? Promise.resolve(
            reply({ error: 'Send the first message before opening conversation files.' }, 409),
          )
        : original(url, ...args),
  );
  const { result } = renderHook(() =>
    useFileNavigation(new URLSearchParams({ sessionId: 'reserved' }), vi.fn()),
  );
  await waitFor(() => expect(result.current.state.loading).toBe(false));
  expect(result.current.state.error).toBe(
    'Send the first message before opening conversation files.',
  );
  await act(async () => result.current.loadWorktrees());
  expect(result.current.state.roots).toEqual([]);
  expect(result.current.state.gitInfo).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).startsWith('/api/git/'))).toBe(
    false,
  );
});
it('refuses late repository worktree discovery after navigation to an ordinary session', async () => {
  fixture();
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let finish!: () => void;
  vi.mocked(apiFetch).mockImplementation((url, ...args) =>
    String(url) === '/api/sessions/repository/meta'
      ? Promise.resolve(reply({ sessionId: 'repository', repositoryWorkspaceId: id }))
      : String(url) === '/api/git/info?worktrees=1'
        ? new Promise((resolve) => {
            finish = () =>
              resolve(
                reply({
                  branch: 'late',
                  repoPath: '/wrong-repo',
                  worktrees: [],
                  worktreesLoaded: true,
                }),
              );
          })
        : original(url, ...args),
  );
  const { result, rerender } = renderHook(
    ({ session }) => useFileNavigation(new URLSearchParams({ sessionId: session }), vi.fn()),
    { initialProps: { session: 'repository' } },
  );
  await waitFor(() => expect(result.current.state.gitInfo).not.toBeNull());
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.loadWorktrees();
  });
  await waitFor(() => expect(finish).toBeDefined());
  rerender({ session: 'ordinary' });
  await waitFor(() => expect(result.current.state.roots[0]?.path).toBe('/private/ordinary'));
  await act(async () => {
    finish();
    await pending;
  });
  expect(result.current.state.gitInfo).toBeNull();
  expect(result.current.state.worktreesLoading).toBe(false);
  const count = vi.mocked(apiFetch).mock.calls.length;
  await act(async () => result.current.loadWorktrees());
  expect(vi.mocked(apiFetch).mock.calls.length).toBe(count);
});
it('ignores late roots and classification from the previous session before its first load finishes', async () => {
  fixture();
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let roots!: () => void, metadata!: () => void;
  vi.mocked(apiFetch).mockImplementation((url, ...args) =>
    String(url) === '/api/files/roots?sessionId=a'
      ? new Promise((resolve) => {
          roots = () => resolve(reply([{ label: 'Old root', path: '/private/a' }]));
        })
      : String(url) === '/api/sessions/a/meta'
        ? new Promise((resolve) => {
            metadata = () => resolve(reply({ repositoryWorkspaceId: id }));
          })
        : original(url, ...args),
  );
  const { result, rerender } = renderHook(
    ({ session }) => useFileNavigation(new URLSearchParams({ sessionId: session }), vi.fn()),
    { initialProps: { session: 'a' } },
  );
  await waitFor(() => expect(roots).toBeDefined());
  await waitFor(() => expect(metadata).toBeDefined());
  rerender({ session: 'b' });
  await waitFor(() => expect(result.current.state.roots[0]?.path).toBe('/private/b'));
  await act(async () => {
    roots();
    metadata();
  });
  expect(result.current.state.roots[0]?.path).toBe('/private/b');
  expect(result.current.state.gitInfo).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).startsWith('/api/git/'))).toBe(
    false,
  );
});

it.each([
  {},
  { sessionId: 'other', repositoryWorkspaceId: id },
  { sessionId: 'selected', ordinaryWorkspaceId: 'bad' },
  { sessionId: 'selected', ordinaryWorkspaceId: id, repositoryWorkspaceId: id },
  { sessionId: 'selected', runtimeCommandScope: 'first-command-only' },
  { sessionId: 'selected', runtimeCommandScope: 'conversation' },
  { sessionId: 'selected', runtimeBinding: { version: 2 } },
  { sessionId: 'selected', repositoryWorkspaceId: 'bad' },
  { sessionId: 'selected', repositoryWorkspaceId: {} },
])(
  'does not expose a scoped roots response as a fallback for unverified metadata: %j',
  async (metadata) => {
    fixture();
    const original = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation((url, ...args) =>
      String(url).endsWith('/meta') ? Promise.resolve(reply(metadata)) : original(url, ...args),
    );
    const { result } = renderHook(() =>
      useFileNavigation(new URLSearchParams({ sessionId: 'selected' }), vi.fn()),
    );
    await waitFor(() => expect(result.current.state.loading).toBe(false));
    await act(async () => result.current.loadWorktrees());
    expect(result.current.state.roots).toEqual([]);
    expect(result.current.state.gitInfo).toBeNull();
    expect(result.current.state.canLoadWorktrees).toBe(false);
    expect(
      vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).startsWith('/api/git/')),
    ).toBe(false);
  },
);

it('keeps an earlier discovery retired when navigating A to B and back to A under a new classification', async () => {
  fixture();
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let finish!: () => void;
  let ordinaryA = false;
  vi.mocked(apiFetch).mockImplementation((url, ...args) =>
    String(url) === '/api/sessions/a/meta' && !ordinaryA
      ? Promise.resolve(reply({ sessionId: 'a', repositoryWorkspaceId: id }))
      : String(url) === '/api/git/info?worktrees=1'
        ? new Promise((resolve) => {
            finish = () =>
              resolve(
                reply({
                  branch: 'retired',
                  repoPath: '/retired',
                  worktrees: [],
                  worktreesLoaded: true,
                }),
              );
          })
        : original(url, ...args),
  );
  const setParams = vi.fn();
  const { result, rerender } = renderHook(
    ({ session }) => useFileNavigation(new URLSearchParams({ sessionId: session }), setParams),
    { initialProps: { session: 'a' } },
  );
  await waitFor(() => expect(result.current.state.gitInfo).not.toBeNull());
  await waitFor(() => expect(result.current.state.loading).toBe(false));
  const retiredOpen = result.current.openEntry;
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.loadWorktrees();
  });
  await waitFor(() => expect(finish).toBeDefined());
  rerender({ session: 'b' });
  await waitFor(() => expect(result.current.state.roots[0]?.path).toBe('/private/b'));
  ordinaryA = true;
  rerender({ session: 'a' });
  await waitFor(() => expect(result.current.state.roots[0]?.path).toBe('/private/a'));
  await act(async () => {
    finish();
    await pending;
  });
  expect(result.current.state.gitInfo).toBeNull();
  expect(result.current.state.canLoadWorktrees).toBe(false);
  act(() => retiredOpen({ name: 'retired-entry.md', isDir: false }, false));
  expect(setParams).not.toHaveBeenCalled();
});

it.each([
  { sessionId: 'selected' },
  {
    sessionId: 'selected',
    repositoryWorkspaceId: id,
    runtimeBinding: { version: 2 },
    runtimeCommandScope: 'conversation',
  },
])('preserves true legacy and explicit repository discovery: %j', async (metadata) => {
  fixture();
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((url, ...args) =>
    String(url).endsWith('/meta') ? Promise.resolve(reply(metadata)) : original(url, ...args),
  );
  const { result } = renderHook(() =>
    useFileNavigation(new URLSearchParams({ sessionId: 'selected' }), vi.fn()),
  );
  await waitFor(() => expect(result.current.state.roots[0]?.path).toBe('/private/selected'));
  await waitFor(() => expect(result.current.state.gitInfo?.repoPath).toBe('/configured-repo'));
  expect(result.current.state.canLoadWorktrees).toBe(true);
});

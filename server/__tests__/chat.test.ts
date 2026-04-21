import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ManagedSession } from '@mitzo/harness';

vi.mock('../worktree.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, removeWorktree: vi.fn() };
});

vi.mock('../repo-config.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadRepoConfig: vi.fn(actual.loadRepoConfig as (...args: unknown[]) => unknown),
  };
});

describe('chat module exports', () => {
  it('exports expected functions', async () => {
    const chat = await import('../chat.js');
    expect(typeof chat.startChat).toBe('function');
    expect(typeof chat.stopChat).toBe('function');
    expect(typeof chat.isActive).toBe('function');
    expect(typeof chat.getSessions).toBe('function');
    expect(typeof chat.getMessages).toBe('function');
    expect(typeof chat.detachChat).toBe('function');
    expect(typeof chat.reattachChat).toBe('function');
    expect(typeof chat.hideSession).toBe('function');
    expect(typeof chat.hideAllSessions).toBe('function');
  });

  it('isActive returns false for unknown client', async () => {
    const { isActive } = await import('../chat.js');
    expect(isActive('nonexistent-client')).toBe(false);
  });

  it('stopChat is safe to call for unknown client', async () => {
    const { stopChat } = await import('../chat.js');
    expect(() => stopChat('nonexistent-client')).not.toThrow();
  });
});

describe('getSessions', () => {
  it('returns an array', async () => {
    const { getSessions } = await import('../chat.js');
    const result = await getSessions();
    expect(Array.isArray(result.sessions)).toBe(true);
    expect(typeof result.hasMore).toBe('boolean');
  });

  it('session objects have expected shape', async () => {
    const { getSessions } = await import('../chat.js');
    const { sessions } = await getSessions();
    for (const s of sessions) {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('summary');
      expect(s).toHaveProperty('lastModified');
    }
  });
});

describe('resolveResumeCwd', () => {
  it('falls back to BASE_REPO when stored CWD no longer exists', async () => {
    const chat = await import('../chat.js');

    const result = chat.resolveResumeCwd(
      { resume: 'sess-test' },
      {
        getSession: () => ({ cwd: '/tmp/deleted-worktree' }),
        pathExists: () => false,
      },
    );

    expect(result).toBe(chat.BASE_REPO);
  });

  it('uses stored CWD when it still exists', async () => {
    const chat = await import('../chat.js');

    const result = chat.resolveResumeCwd(
      { resume: 'sess-test' },
      {
        getSession: () => ({ cwd: '/existing/path' }),
        pathExists: () => true,
      },
    );

    expect(result).toBe('/existing/path');
  });

  it('returns explicit cwd when provided (ignores resume)', async () => {
    const chat = await import('../chat.js');
    const result = chat.resolveResumeCwd({ cwd: '/explicit', resume: 'sess-test' });
    expect(result).toBe('/explicit');
  });

  it('returns BASE_REPO when no resume or cwd', async () => {
    const chat = await import('../chat.js');
    const result = chat.resolveResumeCwd({});
    expect(result).toBe(chat.BASE_REPO);
  });
});

describe('getMessages', () => {
  it('returns an array for unknown session', async () => {
    const { getMessages } = await import('../chat.js');
    const messages = await getMessages('nonexistent-session-id');
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBe(0);
  });
});

describe('cleanupSessionWorktrees', () => {
  let removeWorktreeMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const worktreeMod = await import('../worktree.js');
    removeWorktreeMock = worktreeMod.removeWorktree as ReturnType<typeof vi.fn>;
    removeWorktreeMock.mockReset();
  });

  it('skips primary worktree and only removes secondaries', async () => {
    const { loadRepoConfig } = await import('../repo-config.js');
    (loadRepoConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      repos: { mitzo: '/tools/mitzo', centaur: '/projects/centaur' },
    });

    // Force getRepoConfig TTL cache to expire so our mock is picked up
    const realNow = Date.now;
    Date.now = () => realNow() + 10_000;

    const { cleanupSessionWorktrees } = await import('../chat.js');

    const session = {
      worktreePaths: new Map([
        ['primary', { path: '/repo/.claude/worktrees/abc', wtId: 'abc' }],
        ['mitzo', { path: '/tools/mitzo/.claude/worktrees/abc', wtId: 'abc' }],
        ['centaur', { path: '/projects/centaur/.claude/worktrees/abc', wtId: 'abc' }],
      ]),
    } as unknown as ManagedSession;

    cleanupSessionWorktrees(session);

    expect(removeWorktreeMock).toHaveBeenCalledWith('abc', '/tools/mitzo');
    expect(removeWorktreeMock).toHaveBeenCalledWith('abc', '/projects/centaur');
    expect(removeWorktreeMock).toHaveBeenCalledTimes(2);

    expect(session.worktreePaths.has('primary')).toBe(true);
    expect(session.worktreePaths.get('primary')?.wtId).toBe('abc');

    expect(session.worktreePaths.has('mitzo')).toBe(false);
    expect(session.worktreePaths.has('centaur')).toBe(false);
    expect(session.worktreePaths.size).toBe(1);

    Date.now = realNow;
    vi.restoreAllMocks();
  });

  it('handles session with only primary worktree', async () => {
    const { loadRepoConfig } = await import('../repo-config.js');
    (loadRepoConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      repos: {},
    });

    const realNow = Date.now;
    Date.now = () => realNow() + 10_000;

    const { cleanupSessionWorktrees } = await import('../chat.js');

    const session = {
      worktreePaths: new Map([['primary', { path: '/repo/.claude/worktrees/abc', wtId: 'abc' }]]),
    } as unknown as ManagedSession;

    cleanupSessionWorktrees(session);

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(session.worktreePaths.has('primary')).toBe(true);
    expect(session.worktreePaths.size).toBe(1);

    Date.now = realNow;
    vi.restoreAllMocks();
  });

  it('handles session with no worktrees', async () => {
    const { cleanupSessionWorktrees } = await import('../chat.js');

    const session = {
      worktreePaths: new Map(),
    } as unknown as ManagedSession;

    cleanupSessionWorktrees(session);

    expect(session.worktreePaths.size).toBe(0);
  });
});

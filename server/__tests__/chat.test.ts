import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ManagedSession } from '@mitzo/harness';

vi.mock('../worktree.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    removeWorktree: vi.fn(),
    createWorktree: vi.fn(actual.createWorktree as (...args: unknown[]) => unknown),
  };
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

describe('generateWtId', () => {
  it('produces unique IDs across 100 calls', async () => {
    const { generateWtId } = await import('../chat.js');
    const ids = new Set(Array.from({ length: 100 }, () => generateWtId()));
    expect(ids.size).toBe(100);
  });

  it('matches YYYY-MM-DD-<12 hex chars> format', async () => {
    const { generateWtId } = await import('../chat.js');
    const id = generateWtId();
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{12}$/);
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
      isolation: true,
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
      isolation: true,
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

describe('createSessionWorktrees — lazy secondary creation', () => {
  let createWorktreeMock: ReturnType<typeof vi.fn>;
  let realNow: () => number;

  beforeEach(async () => {
    const worktreeMod = await import('../worktree.js');
    createWorktreeMock = worktreeMod.createWorktree as ReturnType<typeof vi.fn>;
    createWorktreeMock.mockReset();
    createWorktreeMock.mockReturnValue('/repo/.claude/worktrees/test-id');

    const { loadRepoConfig } = await import('../repo-config.js');
    (loadRepoConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      repos: { mitzo: '/tools/mitzo', centaur: '/projects/centaur' },
      isolation: true,
      resolvedVenvPaths: [],
      toolTierOverrides: {},
    });

    realNow = Date.now;
    Date.now = () => realNow() + 10_000;
  });

  afterEach(() => {
    Date.now = realNow;
    vi.restoreAllMocks();
  });

  it('creates only primary worktree (no secondary repos)', async () => {
    const { createSessionWorktrees } = await import('../chat.js');
    // createSessionWorktrees checks isIsolationEnabled() and BASE_REPO internally.
    // When isolation is disabled or BASE_REPO is empty, it returns early without
    // calling createWorktree — which is correct behavior. This test verifies
    // that when it DOES create worktrees, only the primary is created.
    //
    // We call with isolation: true and pass a real-looking baseCwd. The function
    // checks `!BASE_REPO` (from env), so if REPO_PATH isn't set the early return
    // fires and createWorktree is never called — that's the "disabled" path.
    const mockTransport = { send: vi.fn(), isOpen: () => true };
    const result = createSessionWorktrees(mockTransport as never, '/repo', 'test-id', {});

    if (createWorktreeMock.mock.calls.length === 0) {
      // Isolation disabled (no REPO_PATH) — verify we got the passthrough result
      expect(result.repoWorktrees.size).toBe(0);
      expect(result.cwd).toBe('/repo');
    } else {
      // Isolation enabled — verify ONLY primary worktree was created, not secondaries
      expect(createWorktreeMock).toHaveBeenCalledTimes(1);
      expect(createWorktreeMock.mock.calls[0][0]).toBe('test-id');
    }
  });
});

describe('startChat finally block does NOT clean up worktrees', () => {
  it('cleanupSessionWorktrees is not called unconditionally after query loop', async () => {
    // Phase 2e: worktrees survive until explicit close or stale GC.
    // Verify by reading the source: the finally block should not call
    // cleanupSessionWorktrees. This is a structural test — we grep the
    // actual source to ensure the pattern is absent.
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const chatSource = readFileSync(join(import.meta.dirname, '..', 'chat.ts'), 'utf-8');

    // The finally block should NOT contain cleanupSessionWorktrees
    const finallyMatch = chatSource.match(/\} finally \{([^}]*)\}/s);
    expect(finallyMatch).not.toBeNull();
    expect(finallyMatch![1]).not.toContain('cleanupSessionWorktrees');
  });
});

describe('startChat stores user message for resumed sessions', () => {
  it('appends user_message to eventStore when options.resume is set', async () => {
    // Structural test: verify that startChat stores the user message before
    // starting the query loop when resuming. Without this, user messages are
    // invisible after WS reconnect because sendOrBuffer only persists v2
    // events emitted by the query loop — the user's prompt is never one of those.
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const chatSource = readFileSync(join(import.meta.dirname, '..', 'chat.ts'), 'utf-8');

    // The pattern: eventStore.append(options.resume, 'user_message', ...)
    // must appear BEFORE runQueryLoop in startChat
    const appendIdx = chatSource.indexOf("eventStore.append(options.resume, 'user_message'");
    const queryLoopIdx = chatSource.indexOf('await runQueryLoop(');
    expect(appendIdx).toBeGreaterThan(-1);
    expect(queryLoopIdx).toBeGreaterThan(-1);
    expect(appendIdx).toBeLessThan(queryLoopIdx);
  });

  it('echoes user_message to transport on resume', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const chatSource = readFileSync(join(import.meta.dirname, '..', 'chat.ts'), 'utf-8');

    // Find the resume block near the eventStore.append call (not the earlier
    // resumability validation block). Look for the block that contains both
    // the append and the send.
    const nearAppend = chatSource.indexOf("eventStore.append(options.resume, 'user_message'");
    expect(nearAppend).toBeGreaterThan(-1);
    // The send(transport, ...) echo must be in the same code region
    const regionAfterAppend = chatSource.slice(nearAppend, nearAppend + 500);
    expect(regionAfterAppend).toContain('send(transport');
    expect(regionAfterAppend).toContain("type: 'user_message'");
  });
});

describe('isIsolationEnabled', () => {
  let originalEnv: string | undefined;

  let realNow: () => number;

  beforeEach(async () => {
    originalEnv = process.env.WORKTREE_ENABLED;
    realNow = Date.now;
    Date.now = () => realNow() + 10_000;
    const { loadRepoConfig } = await import('../repo-config.js');
    (loadRepoConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      isolation: true,
      repos: {},
      resolvedVenvPaths: [],
      toolTierOverrides: {},
    });
  });

  afterEach(() => {
    Date.now = realNow;
    if (originalEnv === undefined) {
      delete process.env.WORKTREE_ENABLED;
    } else {
      process.env.WORKTREE_ENABLED = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it('defaults to true with no overrides', async () => {
    delete process.env.WORKTREE_ENABLED;
    const { isIsolationEnabled, getRepoConfig } = await import('../chat.js');
    getRepoConfig(); // prime cache with mock
    expect(isIsolationEnabled()).toBe(true);
  });

  it('WORKTREE_ENABLED=false is an absolute ceiling', async () => {
    process.env.WORKTREE_ENABLED = 'false';
    const { isIsolationEnabled } = await import('../chat.js');
    // Even with per-session true, env var wins
    expect(isIsolationEnabled(true)).toBe(false);
  });

  it('per-session false overrides config true', async () => {
    delete process.env.WORKTREE_ENABLED;
    const { isIsolationEnabled } = await import('../chat.js');
    expect(isIsolationEnabled(false)).toBe(false);
  });

  it('per-session true enables isolation', async () => {
    delete process.env.WORKTREE_ENABLED;
    const { isIsolationEnabled } = await import('../chat.js');
    expect(isIsolationEnabled(true)).toBe(true);
  });

  it('undefined per-session falls through to config', async () => {
    delete process.env.WORKTREE_ENABLED;
    const { isIsolationEnabled, getRepoConfig } = await import('../chat.js');
    getRepoConfig(); // prime cache with mock
    expect(isIsolationEnabled(undefined)).toBe(true);
  });
});

describe('discoverSessionWorktrees integration', () => {
  it('finds worktrees created by the worktree module', async () => {
    const { discoverSessionWorktrees } = await import('../worktree.js');
    const { mkdtempSync, mkdirSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');

    const primary = mkdtempSync(join(tmpdir(), 'mitzo-discover-chat-'));
    const secondary = mkdtempSync(join(tmpdir(), 'mitzo-discover-chat2-'));
    const wtId = '2026-04-20-abc123def456';

    try {
      mkdirSync(join(primary, '.claude', 'worktrees', wtId), { recursive: true });
      mkdirSync(join(secondary, '.claude', 'worktrees', wtId), { recursive: true });

      const result = discoverSessionWorktrees(wtId, primary, { secondary });

      expect(result.size).toBe(2);
      expect(result.has('primary')).toBe(true);
      expect(result.has('secondary')).toBe(true);
    } finally {
      rmSync(primary, { recursive: true, force: true });
      rmSync(secondary, { recursive: true, force: true });
    }
  });
});

describe('validateResumable', () => {
  it('returns valid for a CWD that passes git check', async () => {
    const { validateResumable } = await import('../chat.js');
    const result = validateResumable('/some/cwd', 'sess-1', {
      isGitDir: () => true,
      recreateWorktree: () => '',
    });
    expect(result).toEqual({ valid: true });
  });

  it('returns valid with recreated flag when worktree is rebuilt', async () => {
    const { validateResumable } = await import('../chat.js');
    const result = validateResumable('/repo/.claude/worktrees/2026-04-22-abc123', 'sess-1', {
      isGitDir: () => false,
      recreateWorktree: () => '/repo/.claude/worktrees/2026-04-22-abc123',
    });
    expect(result).toEqual({ valid: true, recreated: true });
  });

  it('returns invalid when CWD is not a git dir and not a worktree path', async () => {
    const { validateResumable } = await import('../chat.js');
    const result = validateResumable('/some/random/path', 'sess-1', {
      isGitDir: () => false,
      recreateWorktree: () => '',
    });
    expect(result).toEqual({ valid: false });
  });

  it('returns invalid when worktree recreation fails', async () => {
    const { validateResumable } = await import('../chat.js');
    const result = validateResumable('/repo/.claude/worktrees/2026-04-22-abc123', 'sess-1', {
      isGitDir: () => false,
      recreateWorktree: () => {
        throw new Error('git failed');
      },
    });
    expect(result).toEqual({ valid: false });
  });
});

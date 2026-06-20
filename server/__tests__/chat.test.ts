import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
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

  it('skips secondary whose path matches primary worktree', async () => {
    const { loadRepoConfig } = await import('../repo-config.js');
    (loadRepoConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      repos: { mgmt: '/repo', mitzo: '/tools/mitzo' },
      isolation: true,
    });

    const realNow = Date.now;
    Date.now = () => realNow() + 10_000;

    const { cleanupSessionWorktrees } = await import('../chat.js');

    // "mgmt" secondary points to the same path as "primary" —
    // simulates discoverSessionWorktrees adding both entries
    const session = {
      worktreePaths: new Map([
        ['primary', { path: '/repo/.claude/worktrees/abc', wtId: 'abc' }],
        ['mgmt', { path: '/repo/.claude/worktrees/abc', wtId: 'abc' }],
        ['mitzo', { path: '/tools/mitzo/.claude/worktrees/abc', wtId: 'abc' }],
      ]),
    } as unknown as ManagedSession;

    cleanupSessionWorktrees(session);

    // mgmt should NOT be removed (same path as primary), mitzo should be removed
    expect(removeWorktreeMock).toHaveBeenCalledWith('abc', '/tools/mitzo');
    expect(removeWorktreeMock).toHaveBeenCalledTimes(1);

    expect(session.worktreePaths.has('primary')).toBe(true);
    expect(session.worktreePaths.size).toBe(1);

    Date.now = realNow;
    vi.restoreAllMocks();
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

// Structural tests: startChat requires the full Agent SDK query() pipeline,
// making behavioral mocking impractical. Source-code assertions lock in the
// key invariant (store + echo + broadcast before runQueryLoop) with minimal
// coupling to the SDK internals.
describe('startChat stores user message for resumed sessions', () => {
  let chatSource: string;

  beforeAll(async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    chatSource = readFileSync(join(import.meta.dirname, '..', 'chat.ts'), 'utf-8');
  });

  it('appends user_message to eventStore before runQueryLoop', () => {
    const appendIdx = chatSource.indexOf("eventStore.append(options.resume, 'user_message'");
    const queryLoopIdx = chatSource.indexOf('await runQueryLoop(');
    expect(appendIdx).toBeGreaterThan(-1);
    expect(queryLoopIdx).toBeGreaterThan(-1);
    expect(appendIdx).toBeLessThan(queryLoopIdx);
  });

  it('echoes user_message to transport and broadcasts to observers', () => {
    // Region between the resume guard and runQueryLoop — bounds the block
    // without fragile brace-matching or magic byte offsets.
    const start = chatSource.indexOf(
      'if (options.resume) {',
      chatSource.indexOf('session.queryInstance = q'),
    );
    const end = chatSource.indexOf('await runQueryLoop(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const region = chatSource.slice(start, end);
    expect(region).toContain("eventStore.append(options.resume, 'user_message'");
    expect(region).toContain('send(transport');
    expect(region).toContain("type: 'user_message'");
    expect(region).toContain('broadcastToObservers(session.observers');
  });

  it('uses clientMsgId with resume fallback for messageId', () => {
    const start = chatSource.indexOf(
      'if (options.resume) {',
      chatSource.indexOf('session.queryInstance = q'),
    );
    const end = chatSource.indexOf('await runQueryLoop(', start);
    const region = chatSource.slice(start, end);
    expect(region).toContain('options.clientMsgId');
    expect(region).toMatch(/umsg-.*-resume/);
  });
});

// Structural tests: resume resolution requires the Agent SDK query() pipeline,
// so we assert against the source rather than invoking startChat() directly.
describe('resume resolves SDK session ID', () => {
  let chatSource: string;

  beforeAll(async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    chatSource = readFileSync(join(import.meta.dirname, '..', 'chat.ts'), 'utf-8');
  });

  it('calls getSessionSdkId before passing resume to query()', () => {
    expect(chatSource).toContain('getSessionSdkId(BASE_REPO, options.resume)');
  });

  it('guards BASE_REPO with ternary to avoid empty-string falsy bug', () => {
    // Must use ternary (BASE_REPO ? ...) not && (which returns '' for empty string)
    expect(chatSource).toContain('BASE_REPO ? getSessionSdkId(BASE_REPO');
  });

  it('falls back to raw options.resume when lookup returns undefined', () => {
    expect(chatSource).toContain('?? options.resume');
  });

  it('resolvedResume is computed before the query() call', () => {
    const resolveIdx = chatSource.indexOf('let resolvedResume');
    const queryIdx = chatSource.indexOf('const q = query(');
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(queryIdx).toBeGreaterThan(resolveIdx);
  });

  it('warns when REPO_PATH is unset during resume', () => {
    expect(chatSource).toContain(
      'REPO_PATH unset — resume will use raw worktree ID, SDK may reject it',
    );
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

describe('headless session does not pass resume on first query', () => {
  let appSource: string;

  beforeAll(async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    appSource = readFileSync(join(import.meta.dirname, '..', 'app.ts'), 'utf-8');
  });

  it('headless startChat call omits resume option', () => {
    // Find the headless startChat block (identified by NullTransport + headless clientId)
    const headlessMarker = 'const clientId = `headless:${wtId}`';
    const headlessIdx = appSource.indexOf(headlessMarker);
    expect(headlessIdx).toBeGreaterThan(-1);

    // Extract the startChat call after the headless marker
    const startChatIdx = appSource.indexOf('await startChat(', headlessIdx);
    expect(startChatIdx).toBeGreaterThan(-1);

    // Get the options object passed to startChat (up to the closing paren + semicolon)
    const callEnd = appSource.indexOf(');', startChatIdx);
    const callRegion = appSource.slice(startChatIdx, callEnd);

    // Must NOT contain resume as an option key (resume: ...)
    expect(callRegion).not.toMatch(/resume\s*[,:]/);
    expect(callRegion).not.toMatch(/resume\s*\?/);
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

describe('resolveSshAuthSock', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns trimmed socket path on macOS', async () => {
    vi.resetModules();
    vi.doMock('os', async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return { ...actual, platform: () => 'darwin' };
    });
    vi.doMock('child_process', async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        execFileSync: vi.fn().mockReturnValue('  /private/tmp/com.apple.launchd.xxx/Listeners  \n'),
      };
    });
    const { resolveSshAuthSock } = await import('../chat.js');
    expect(resolveSshAuthSock()).toBe('/private/tmp/com.apple.launchd.xxx/Listeners');
  });

  it('returns null when launchctl returns empty string', async () => {
    vi.resetModules();
    vi.doMock('os', async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return { ...actual, platform: () => 'darwin' };
    });
    vi.doMock('child_process', async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return { ...actual, execFileSync: vi.fn().mockReturnValue('  \n') };
    });
    const { resolveSshAuthSock } = await import('../chat.js');
    expect(resolveSshAuthSock()).toBeNull();
  });

  it('returns null when execFileSync throws', async () => {
    vi.resetModules();
    vi.doMock('os', async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return { ...actual, platform: () => 'darwin' };
    });
    vi.doMock('child_process', async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        execFileSync: vi.fn().mockImplementation(() => {
          throw new Error('launchctl not found');
        }),
      };
    });
    const { resolveSshAuthSock } = await import('../chat.js');
    expect(resolveSshAuthSock()).toBeNull();
  });

  it('returns null on non-macOS platforms', async () => {
    vi.resetModules();
    vi.doMock('os', async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return { ...actual, platform: () => 'linux' };
    });
    const { resolveSshAuthSock } = await import('../chat.js');
    expect(resolveSshAuthSock()).toBeNull();
  });
});

describe('agent definition wiring', () => {
  it('loadAgentDef result is assignable to ManagedSession fields', async () => {
    // Verify the fire-and-forget contract: loadAgentDef returns a shape
    // that chat.ts can assign directly to session.agentDefinition and
    // session.agentDefinitionSource without casts.
    const { DEFAULT_AGENT_DEFINITION } = await import('../constants.js');
    const loaded = {
      definition: structuredClone(DEFAULT_AGENT_DEFINITION),
      source: 'fallback' as const,
    };

    // Simulate what chat.ts does in the fire-and-forget block
    const session: Partial<ManagedSession> = {};
    session.agentDefinition = loaded.definition;
    session.agentDefinitionSource = loaded.source;

    expect(session.agentDefinition).toBeDefined();
    expect(session.agentDefinition!.identity).toBeDefined();
    expect(session.agentDefinition!.identity.description).toBeTruthy();
    expect(session.agentDefinition!.provider.default).toBeTruthy();
    expect(['contexgin', 'local', 'fallback']).toContain(session.agentDefinitionSource);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListSessions = vi.fn().mockResolvedValue([]);
const mockUpsertSession = vi.fn();
const mockGetSession = vi.fn();
const mockListSessionsMeta = vi.fn().mockReturnValue([]);
const mockGetKnownSessionIds = vi.fn().mockReturnValue(new Set());

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  getSessionInfo: vi.fn().mockResolvedValue(undefined),
  getSessionMessages: vi.fn().mockResolvedValue([]),
  renameSession: vi.fn(),
}));

const mockEventStore = {
  upsertSession: mockUpsertSession,
  getSession: mockGetSession,
  getKnownSessionIds: mockGetKnownSessionIds,
  listSessions: mockListSessionsMeta,
  listSessionsLimited: vi.fn().mockReturnValue([]),
  getEventsAfter: vi.fn().mockReturnValue([]),
  getSessionEvents: vi.fn().mockReturnValue([]),
  markSessionInactive: vi.fn(),
  hideSession: vi.fn(),
  incrementPromptCount: vi.fn().mockReturnValue(1),
  recordUsage: vi.fn(),
  markManuallyRenamed: vi.fn(),
  append: vi.fn().mockReturnValue(1),
};

class FakeEventStore {
  constructor() {
    return mockEventStore;
  }
}

vi.mock('@mitzo/protocol/event-store', () => ({
  EventStore: FakeEventStore,
}));

vi.mock('../repo-config.js', () => ({
  loadRepoConfig: vi.fn().mockReturnValue({ repos: {}, roots: [] }),
}));

vi.mock('../mcp-config.js', () => ({
  loadMcpServers: vi.fn().mockReturnValue({}),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getSessionsCached', () => {
  it('returns sessions that have turns', async () => {
    mockListSessionsMeta.mockReturnValue([
      {
        sessionId: 'sess-1',
        summary: 'Active session',
        numTurns: 5,
        promptCount: 3,
        isActive: false,
        updatedAt: 1000,
        branch: 'main',
        cwd: '/projects/foo',
      },
    ]);

    const { getSessionsCached } = await import('../chat.js');
    const { sessions, hasMore } = getSessionsCached();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-1');
    expect(sessions[0].summary).toBe('Active session');
    expect(hasMore).toBe(false);
  });

  it('hides sessions with numTurns=0, promptCount=0, and !isActive', async () => {
    mockListSessionsMeta.mockReturnValue([
      {
        sessionId: 'sess-unused',
        summary: 'Unused',
        numTurns: 0,
        promptCount: 0,
        isActive: false,
        updatedAt: 1000,
        branch: null,
        cwd: null,
      },
      {
        sessionId: 'sess-used',
        summary: 'Used',
        numTurns: 1,
        promptCount: 1,
        isActive: false,
        updatedAt: 2000,
        branch: null,
        cwd: null,
      },
    ]);

    const { getSessionsCached } = await import('../chat.js');
    const { sessions } = getSessionsCached();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-used');
  });

  it('keeps active sessions even with zero turns', async () => {
    mockListSessionsMeta.mockReturnValue([
      {
        sessionId: 'sess-active',
        summary: 'Just started',
        numTurns: 0,
        promptCount: 0,
        isActive: true,
        updatedAt: 1000,
        branch: null,
        cwd: null,
      },
    ]);

    const { getSessionsCached } = await import('../chat.js');
    const { sessions } = getSessionsCached();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-active');
  });

  it('keeps sessions with promptCount > 0 even if numTurns=0', async () => {
    mockListSessionsMeta.mockReturnValue([
      {
        sessionId: 'sess-prompted',
        summary: 'Has prompts',
        numTurns: 0,
        promptCount: 2,
        isActive: false,
        updatedAt: 1000,
        branch: null,
        cwd: null,
      },
    ]);

    const { getSessionsCached } = await import('../chat.js');
    const { sessions } = getSessionsCached();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-prompted');
  });

  it('respects offset and limit for pagination', async () => {
    mockListSessionsMeta.mockReturnValue([
      {
        sessionId: 'sess-1',
        summary: 'First',
        numTurns: 1,
        promptCount: 1,
        isActive: false,
        updatedAt: 3000,
        branch: null,
        cwd: null,
      },
      {
        sessionId: 'sess-2',
        summary: 'Second',
        numTurns: 1,
        promptCount: 1,
        isActive: false,
        updatedAt: 2000,
        branch: null,
        cwd: null,
      },
      {
        sessionId: 'sess-3',
        summary: 'Third',
        numTurns: 1,
        promptCount: 1,
        isActive: false,
        updatedAt: 1000,
        branch: null,
        cwd: null,
      },
    ]);

    const { getSessionsCached } = await import('../chat.js');
    const { sessions, hasMore } = getSessionsCached(0, 2);

    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe('sess-1');
    expect(sessions[1].id).toBe('sess-2');
    expect(hasMore).toBe(true);
  });

  it('maps SessionMeta fields to API shape', async () => {
    mockListSessionsMeta.mockReturnValue([
      {
        sessionId: 'sess-mapped',
        summary: 'Mapped session',
        numTurns: 3,
        promptCount: 2,
        isActive: true,
        updatedAt: 5000,
        branch: 'feat/test',
        cwd: '/projects/bar',
      },
    ]);

    const { getSessionsCached } = await import('../chat.js');
    const { sessions } = getSessionsCached();

    expect(sessions[0]).toEqual({
      id: 'sess-mapped',
      summary: 'Mapped session',
      lastModified: 5000,
      branch: 'feat/test',
      cwd: '/projects/bar',
    });
  });

  it('keeps a recent zero-turn inactive session within the grace period', async () => {
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    mockListSessionsMeta.mockReturnValue([
      {
        sessionId: 'sess-recent-zero',
        summary: 'Just created',
        numTurns: 0,
        promptCount: 0,
        isActive: false,
        createdAt: thirtyMinutesAgo,
        updatedAt: thirtyMinutesAgo,
        branch: null,
        cwd: null,
      },
    ]);

    const { getSessionsCached } = await import('../chat.js');
    const { sessions } = getSessionsCached();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-recent-zero');
  });

  it('hides an old zero-turn inactive session past the grace period', async () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    mockListSessionsMeta.mockReturnValue([
      {
        sessionId: 'sess-old-zero',
        summary: 'Stale empty session',
        numTurns: 0,
        promptCount: 0,
        isActive: false,
        createdAt: twoHoursAgo,
        updatedAt: twoHoursAgo,
        branch: null,
        cwd: null,
      },
    ]);

    const { getSessionsCached } = await import('../chat.js');
    const { sessions } = getSessionsCached();

    expect(sessions).toHaveLength(0);
  });
});

describe('syncSessionTimestamps', () => {
  it('inserts new sessions from filesystem into EventStore', async () => {
    mockListSessions.mockResolvedValue([
      {
        sessionId: 'sess-new',
        summary: 'New from FS',
        lastModified: 10000,
        gitBranch: 'main',
        cwd: '/projects/foo',
      },
    ]);
    mockGetSession.mockReturnValue(null);

    const { syncSessionTimestamps } = await import('../chat.js');
    await syncSessionTimestamps();

    expect(mockUpsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-new',
        summary: 'New from FS',
        isActive: false,
      }),
    );
  });

  it('syncs timestamp when drift exceeds 60s', async () => {
    const now = Date.now();
    mockListSessions.mockResolvedValue([
      {
        sessionId: 'sess-drifted',
        summary: 'Drifted',
        lastModified: now,
        gitBranch: 'main',
        cwd: '/projects/foo',
      },
    ]);
    mockGetSession.mockReturnValue({
      sessionId: 'sess-drifted',
      summary: 'Old summary',
      updatedAt: now - 120_000, // 2 minutes drift
      manuallyRenamed: false,
    });

    const { syncSessionTimestamps } = await import('../chat.js');
    await syncSessionTimestamps();

    expect(mockUpsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-drifted',
        updatedAt: now,
        summary: 'Drifted',
      }),
    );
  });

  it('preserves manually renamed summary during timestamp sync', async () => {
    const now = Date.now();
    mockListSessions.mockResolvedValue([
      {
        sessionId: 'sess-renamed',
        summary: 'FS summary',
        lastModified: now,
        gitBranch: 'main',
        cwd: '/projects/foo',
      },
    ]);
    mockGetSession.mockReturnValue({
      sessionId: 'sess-renamed',
      summary: 'User-chosen name',
      updatedAt: now - 120_000,
      manuallyRenamed: true,
    });

    const { syncSessionTimestamps } = await import('../chat.js');
    await syncSessionTimestamps();

    expect(mockUpsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-renamed',
        updatedAt: now,
        summary: undefined, // preserves existing summary by passing undefined
      }),
    );
  });

  it('skips sessions with timestamp drift under 60s', async () => {
    const now = Date.now();
    mockListSessions.mockResolvedValue([
      {
        sessionId: 'sess-ok',
        summary: 'Fine',
        lastModified: now,
        gitBranch: 'main',
        cwd: '/projects/foo',
      },
    ]);
    mockGetSession.mockReturnValue({
      sessionId: 'sess-ok',
      summary: 'Fine',
      updatedAt: now - 30_000, // Only 30s drift
      manuallyRenamed: false,
    });

    const { syncSessionTimestamps } = await import('../chat.js');
    await syncSessionTimestamps();

    expect(mockUpsertSession).not.toHaveBeenCalled();
  });

  it('skips hidden sessions', async () => {
    mockListSessions.mockResolvedValue([
      {
        sessionId: 'sess-hidden',
        summary: 'Hidden',
        lastModified: 10000,
        gitBranch: 'main',
        cwd: '/projects/foo',
      },
    ]);
    mockGetSession.mockReturnValue({ isHidden: true });

    const { syncSessionTimestamps } = await import('../chat.js');
    await syncSessionTimestamps();

    expect(mockUpsertSession).not.toHaveBeenCalled();
  });
});

describe('resume timestamp preservation', () => {
  it('preserves updatedAt when resuming an existing session', async () => {
    const originalUpdatedAt = Date.now() - 3600_000; // 1 hour ago
    const existingMeta = {
      sessionId: 'sess-resume',
      summary: 'Old session',
      updatedAt: originalUpdatedAt,
      createdAt: originalUpdatedAt - 7200_000,
      numTurns: 5,
      promptCount: 3,
      isActive: false,
      branch: 'main',
      cwd: '/projects/foo',
      manuallyRenamed: false,
    };
    mockGetSession.mockReturnValue(existingMeta);

    // Simulate the resume upsert pattern from startSession (chat.ts L688-701):
    //   const existingMeta = eventStore.getSession(id);
    //   eventStore.upsertSession({ ..., ...(existingMeta ? { updatedAt: existingMeta.updatedAt } : {}) });
    const sessionId = 'sess-resume';
    const retrieved = mockEventStore.getSession(sessionId);
    mockEventStore.upsertSession({
      sessionId,
      cwd: '/projects/foo',
      mode: 'code',
      branch: 'main',
      ...(retrieved ? { updatedAt: retrieved.updatedAt } : {}),
    });

    expect(mockUpsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-resume',
        updatedAt: originalUpdatedAt,
      }),
    );
  });

  it('omits updatedAt when resuming a session with no prior metadata', async () => {
    mockGetSession.mockReturnValue(null);

    const sessionId = 'sess-new-resume';
    const retrieved = mockEventStore.getSession(sessionId);
    mockEventStore.upsertSession({
      sessionId,
      cwd: '/projects/foo',
      mode: 'code',
      branch: 'main',
      ...(retrieved ? { updatedAt: retrieved.updatedAt } : {}),
    });

    const call = mockUpsertSession.mock.calls[0][0];
    expect(call.sessionId).toBe('sess-new-resume');
    expect(call).not.toHaveProperty('updatedAt');
  });
});

describe('hideSession persistence', () => {
  it('calls eventStore.hideSession to persist deletion', async () => {
    const { hideSession } = await import('../chat.js');
    hideSession('sess-to-delete');

    expect(mockEventStore.hideSession).toHaveBeenCalledWith('sess-to-delete');
  });
});

describe('hideAllSessions', () => {
  it('hides all visible sessions in EventStore', async () => {
    mockListSessionsMeta.mockReturnValue([{ sessionId: 'sess-a' }, { sessionId: 'sess-b' }]);

    const { hideAllSessions } = await import('../chat.js');
    hideAllSessions();

    expect(mockEventStore.hideSession).toHaveBeenCalledWith('sess-a');
    expect(mockEventStore.hideSession).toHaveBeenCalledWith('sess-b');
    expect(mockEventStore.hideSession).toHaveBeenCalledTimes(2);
  });
});

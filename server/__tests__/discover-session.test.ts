import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSessionInfo = vi.fn();
const mockUpsertSession = vi.fn();
const mockGetSession = vi.fn();
const mockGetKnownSessionIds = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  listSessions: vi.fn().mockResolvedValue([]),
  getSessionInfo: (...args: unknown[]) => mockGetSessionInfo(...args),
  getSessionMessages: vi.fn().mockResolvedValue([]),
  renameSession: vi.fn(),
}));

const mockEventStore = {
  upsertSession: mockUpsertSession,
  getSession: mockGetSession,
  getKnownSessionIds: mockGetKnownSessionIds,
  listSessions: vi.fn().mockReturnValue([]),
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

describe('discoverSession', () => {
  it('returns backfilled SessionMeta when SDK finds the session', async () => {
    mockGetSessionInfo.mockResolvedValue({
      sessionId: 'sess-orphan',
      summary: 'Orphaned session',
      cwd: '/projects/foo',
      gitBranch: 'main',
      lastModified: Date.now(),
    });
    mockGetSession.mockReturnValue({
      sessionId: 'sess-orphan',
      summary: 'Orphaned session',
      cwd: '/projects/foo',
      branch: 'main',
      mode: 'agent',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
    });

    const { discoverSession } = await import('../chat.js');
    const result = await discoverSession('sess-orphan');

    expect(mockGetSessionInfo).toHaveBeenCalledWith('sess-orphan');
    expect(mockUpsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-orphan',
        cwd: '/projects/foo',
        branch: 'main',
      }),
    );
    expect(result).toBeTruthy();
    expect(result!.sessionId).toBe('sess-orphan');
  });

  it('returns null when SDK does not find the session', async () => {
    mockGetSessionInfo.mockResolvedValue(undefined);

    const { discoverSession } = await import('../chat.js');
    const result = await discoverSession('sess-gone');

    expect(mockGetSessionInfo).toHaveBeenCalledWith('sess-gone');
    expect(mockUpsertSession).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('returns null and logs warning when SDK throws', async () => {
    mockGetSessionInfo.mockRejectedValue(new Error('SDK exploded'));

    const { discoverSession } = await import('../chat.js');
    const result = await discoverSession('sess-boom');

    expect(result).toBeNull();
    expect(mockUpsertSession).not.toHaveBeenCalled();
  });
});

describe('getSessions reconciliation', () => {
  it('backfills EventStore for sessions the SDK knows but EventStore does not', async () => {
    const mockListSessions = (await import('@anthropic-ai/claude-agent-sdk'))
      .listSessions as ReturnType<typeof vi.fn>;
    mockListSessions.mockResolvedValue([
      {
        sessionId: 'sess-known',
        summary: 'Known',
        lastModified: 1000,
        cwd: '/projects/foo',
        gitBranch: 'main',
      },
      {
        sessionId: 'sess-orphan',
        summary: 'Orphan',
        lastModified: 2000,
        cwd: '/projects/bar',
        gitBranch: 'feat',
      },
    ]);
    mockGetKnownSessionIds.mockReturnValue(new Set(['sess-known']));

    const { getSessions } = await import('../chat.js');
    const result = await getSessions();

    expect(mockGetKnownSessionIds).toHaveBeenCalled();
    expect(mockUpsertSession).toHaveBeenCalledTimes(1);
    expect(mockUpsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-orphan',
        summary: 'Orphan',
        cwd: '/projects/bar',
        branch: 'feat',
        isActive: false,
      }),
    );

    // Backfilled sessions should appear in the returned list
    const ids = result.sessions.map((s: { id: string }) => s.id);
    expect(ids).toContain('sess-orphan');
    expect(ids).toContain('sess-known');
  });
});

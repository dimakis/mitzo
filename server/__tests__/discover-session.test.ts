import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSessionInfo = vi.fn();
const mockUpsertSession = vi.fn();
const mockGetSession = vi.fn();
const mockGetKnownSessionIds = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  listSessions: vi.fn().mockResolvedValue([]),
  getSessionInfo: (...args: unknown[]) => mockGetSessionInfo(...args),
  getSessionMessages: vi.fn().mockResolvedValue([{ type: 'user' }]),
  renameSession: vi.fn(),
}));

const mockEventStore = {
  upsertSession: mockUpsertSession,
  getInternalSdkExecution: vi.fn().mockReturnValue(null),
  isSessionHidden: vi.fn().mockReturnValue(false),
  getSession: mockGetSession,
  getKnownSessionIds: mockGetKnownSessionIds,
  listSessions: vi.fn().mockReturnValue([]),
  getEventsAfter: vi.fn().mockReturnValue([]),
  getSessionEvents: vi.fn().mockReturnValue([]),
  getSessionEventsThroughCursor: vi.fn().mockReturnValue([]),
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
  loadRepoConfig: vi
    .fn()
    .mockReturnValue({ repos: { configured: '/configured-sdk-history' }, roots: [] }),
}));

vi.mock('../mcp-config.js', () => ({
  loadMcpServers: vi.fn().mockReturnValue({}),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  mockGetSession.mockReset();
  mockGetSessionInfo.mockReset();
  mockEventStore.getInternalSdkExecution.mockReset().mockReturnValue(null);
  mockEventStore.isSessionHidden.mockReset().mockReturnValue(false);
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  vi.mocked(sdk.listSessions).mockReset().mockResolvedValue([]);
  vi.mocked(sdk.getSessionMessages)
    .mockReset()
    .mockResolvedValue([{ type: 'user' }] as never);
  mockEventStore.getSessionEvents.mockReturnValue([]);
  mockEventStore.getSessionEventsThroughCursor.mockReturnValue([]);
});

describe('importSdkConversation', () => {
  it('preserves an already registered active conversation without consulting provider history', async () => {
    const active = {
      sessionId: 'active-mitzo',
      conversationSource: 'mitzo',
      isActive: true,
      summary: 'Controller title',
      cwd: '/controller/worktree',
      accountBinding: { accountId: 'selected-account', provider: 'anthropic' },
    };
    mockGetSession.mockReturnValue(active);
    mockGetSessionInfo.mockResolvedValue({
      sessionId: active.sessionId,
      summary: 'Provider title',
      cwd: '/provider/worktree',
      lastModified: Date.now(),
    });
    const { importSdkConversation } = await import('../chat.js');
    expect(await importSdkConversation(active.sessionId)).toBe(active);
    expect(mockGetSessionInfo).not.toHaveBeenCalled();
    expect(mockUpsertSession).not.toHaveBeenCalled();
  });

  it.each(['registered', 'hidden', 'internal'] as const)(
    'does not adopt history whose ownership becomes %s while provider history is loading',
    async (state) => {
      const active = {
        sessionId: 'racing-history',
        conversationSource: 'mitzo',
        isActive: true,
        summary: 'Registered during provider lookup',
      };
      mockGetSession.mockReturnValue(null);
      mockGetSessionInfo.mockResolvedValue({
        sessionId: active.sessionId,
        summary: 'External SDK title',
        cwd: '/external/worktree',
        lastModified: Date.now(),
      });
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      vi.mocked(sdk.getSessionMessages).mockImplementation(async () => {
        if (state === 'registered') mockGetSession.mockReturnValue(active);
        if (state === 'hidden') mockEventStore.isSessionHidden.mockReturnValue(true);
        if (state === 'internal')
          mockEventStore.getInternalSdkExecution.mockReturnValue({ parentSessionId: 'parent' });
        return [{ type: 'user' }] as never;
      });
      const { importSdkConversation } = await import('../chat.js');
      expect(await importSdkConversation(active.sessionId)).toBe(
        state === 'registered' ? active : null,
      );
      expect(sdk.getSessionMessages).toHaveBeenCalled();
      expect(mockUpsertSession).not.toHaveBeenCalled();
    },
  );

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

    const { importSdkConversation } = await import('../chat.js');
    const result = await importSdkConversation('sess-orphan');

    expect(mockGetSessionInfo).toHaveBeenCalledWith('sess-orphan', { dir: expect.any(String) });
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

  it('does not backfill a title-only record as a conversation', async () => {
    mockGetSessionInfo.mockResolvedValue({ sessionId: 'ghost', summary: 'Pricing inquiry' });
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    vi.mocked(sdk.getSessionMessages).mockResolvedValue([]);
    const { importSdkConversation } = await import('../chat.js');
    expect(await importSdkConversation('ghost')).toBeNull();
    expect(mockUpsertSession).not.toHaveBeenCalled();
  });

  it('does not import an internal execution even if the SDK has a complete transcript', async () => {
    mockEventStore.getInternalSdkExecution.mockReturnValueOnce({ parentSessionId: 'parent' });
    mockGetSessionInfo.mockResolvedValue({ sessionId: 'helper', firstPrompt: 'Search prompt' });
    const { importSdkConversation } = await import('../chat.js');
    expect(await importSdkConversation('helper')).toBeNull();
    expect(mockGetSessionInfo).not.toHaveBeenCalled();
    expect(mockUpsertSession).not.toHaveBeenCalled();
  });
  it('requires actual history even when a stale SDK index advertises a first prompt', async () => {
    mockGetSessionInfo.mockResolvedValue({
      sessionId: 'stale-index',
      firstPrompt: 'Old prompt',
      lastModified: Date.now(),
    });
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    vi.mocked(sdk.getSessionMessages).mockResolvedValue([]);
    const { importSdkConversation } = await import('../chat.js');
    expect(await importSdkConversation('stale-index')).toBeNull();
    expect(mockUpsertSession).not.toHaveBeenCalled();
  });
  it('returns null when SDK does not find the session', async () => {
    mockGetSessionInfo.mockResolvedValue(undefined);

    const { importSdkConversation } = await import('../chat.js');
    const result = await importSdkConversation('sess-gone');

    expect(mockGetSessionInfo).toHaveBeenCalledWith('sess-gone', { dir: expect.any(String) });
    expect(mockUpsertSession).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('returns null and logs warning when SDK throws', async () => {
    mockGetSessionInfo.mockRejectedValue(new Error('SDK exploded'));

    const { importSdkConversation } = await import('../chat.js');
    const result = await importSdkConversation('sess-boom');

    expect(result).toBeNull();
    expect(mockUpsertSession).not.toHaveBeenCalled();
  });
});

describe('registered conversation recovery', () => {
  it('keeps unknown provider histories out of the chat registry', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    vi.mocked(sdk.listSessions).mockResolvedValue([
      {
        sessionId: 'external',
        summary: 'External',
        firstPrompt: 'Full transcript',
        lastModified: 1000,
      },
    ]);
    mockGetSession.mockReturnValue(null);
    mockEventStore.listSessions.mockReturnValue([]);
    const { getSessions } = await import('../chat.js');
    expect((await getSessions()).sessions).toEqual([]);
    expect(mockUpsertSession).not.toHaveBeenCalled();
  });
});

describe('legacy message artifact workspace', () => {
  it('recovers missing cwd while preserving existing session metadata', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    vi.mocked(sdk.getSessionMessages).mockResolvedValue([
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '[Report](report.md)' }] },
      },
    ] as never);
    mockGetSession.mockReturnValue({
      sessionId: 'legacy',
      cwd: null,
      summary: 'Custom title',
      isActive: false,
      updatedAt: 12345,
    });
    mockGetSessionInfo.mockResolvedValue({
      sessionId: 'legacy',
      cwd: '/projects/original-worktree',
    });
    const { getMessages } = await import('../chat.js');
    await getMessages('legacy');
    expect(mockUpsertSession).toHaveBeenCalledWith({
      sessionId: 'legacy',
      cwd: '/projects/original-worktree',
      updatedAt: 12345,
    });
    expect(mockGetSessionInfo).toHaveBeenCalledWith(
      'legacy',
      expect.objectContaining({ dir: expect.any(String) }),
    );
  });
});

it('keeps legacy messages available when workspace metadata cannot be recovered', async () => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  vi.mocked(sdk.getSessionMessages).mockResolvedValue([
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Report' }] },
    },
  ] as never);
  mockGetSession.mockReturnValue({ sessionId: 'legacy', cwd: null });
  mockGetSessionInfo.mockRejectedValue(new Error('Metadata unavailable'));
  const { getMessages } = await import('../chat.js');
  expect(await getMessages('legacy')).toHaveLength(1);
  expect(mockUpsertSession).not.toHaveBeenCalled();
});

it('does not replace a recorded historical workspace with SDK metadata', async () => {
  mockGetSession.mockReturnValue({ sessionId: 'legacy', cwd: '/recorded/worktree' });
  const { getMessages } = await import('../chat.js');
  await getMessages('legacy');
  expect(mockGetSessionInfo).not.toHaveBeenCalled();
  expect(mockUpsertSession).not.toHaveBeenCalled();
});

const savedEvents = [
  { seq: 1, type: 'user_message', payload: { prompt: 'Saved request' }, timestamp: 1 },
];

it.each(['getMessages', 'getSessionTranscript'] as const)(
  'recovers missing workspace for durable %s history',
  async (method) => {
    mockEventStore.getSessionEvents.mockReturnValue(savedEvents);
    mockGetSession.mockReturnValue({
      sessionId: 'persisted',
      cwd: null,
      accountBinding: { provider: 'anthropic' },
      summary: 'Keep title',
    });
    mockGetSessionInfo.mockResolvedValue({ cwd: '/projects/existing-worktree' });
    const chat = await import('../chat.js');
    await chat[method]('persisted');
    expect(mockUpsertSession).toHaveBeenCalledWith({
      sessionId: 'persisted',
      cwd: '/projects/existing-worktree',
    });
  },
);

it('does not look up mutable metadata for bounded durable history', async () => {
  mockEventStore.getSessionEventsThroughCursor.mockReturnValue(savedEvents);
  mockGetSession.mockReturnValue({ sessionId: 'persisted', cwd: null });
  const { getMessages } = await import('../chat.js');
  await getMessages('persisted', 1);
  expect(mockGetSessionInfo).not.toHaveBeenCalled();
  expect(mockUpsertSession).not.toHaveBeenCalled();
});

it.each([undefined, '', 'relative/worktree', 42])(
  'ignores malformed recovered cwd %s',
  async (cwd) => {
    mockEventStore.getSessionEvents.mockReturnValue(savedEvents);
    mockGetSession.mockReturnValue({ sessionId: 'persisted', cwd: null });
    mockGetSessionInfo.mockResolvedValue({ cwd });
    const { getMessages } = await import('../chat.js');
    await getMessages('persisted');
    expect(mockGetSessionInfo).toHaveBeenCalled();
    expect(mockUpsertSession).not.toHaveBeenCalled();
  },
);

it('preserves a timestamp updated while legacy workspace metadata is being recovered', async () => {
  mockEventStore.getSessionEvents.mockReturnValue(savedEvents);
  mockGetSession
    .mockReturnValueOnce({ sessionId: 'persisted', cwd: null, updatedAt: 12345 })
    .mockReturnValue({ sessionId: 'persisted', cwd: null, updatedAt: 67890 });
  mockGetSessionInfo.mockResolvedValue({ cwd: '/projects/existing-worktree' });
  const { getMessages } = await import('../chat.js');
  await getMessages('persisted');
  expect(mockUpsertSession).toHaveBeenCalledWith({
    sessionId: 'persisted',
    cwd: '/projects/existing-worktree',
    updatedAt: 67890,
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BootContextMessage } from '../chat.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock logger to suppress output
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock the event store to avoid SQLite initialization
class FakeEventStore {
  recordEvent = vi.fn();
  getEvents = vi.fn().mockReturnValue([]);
  getSession = vi.fn().mockReturnValue(null);
  upsertSession = vi.fn();
}
vi.mock('../event-store.js', () => ({
  EventStore: FakeEventStore,
}));

// Mock repo-config
vi.mock('../repo-config.js', () => ({
  loadRepoConfig: vi.fn(() => ({
    contextBlocks: {},
    quickActions: [],
    venvPaths: [],
    resolvedVenvPaths: [],
    allowedPaths: [],
    roots: [],
    toolTierOverrides: {},
    inboxPath: '',
    resolvedInboxPath: '',
    repos: {},
    isolation: true,
  })),
}));

const { fetchBootContext } = await import('../chat.js');

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchBootContext', () => {
  const CONTEXGIN_URL = 'http://localhost:4195';

  it('returns contexgin boot context on successful response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        agent: 'mitzo-conversational',
        boot: {
          content: '# Boot payload\nContext here.',
          tokens: 11297,
          sources: ['CONSTITUTION.md', 'memory/Profile/Principles.md'],
        },
      }),
    });

    const result = await fetchBootContext('mitzo-conversational', CONTEXGIN_URL);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      `${CONTEXGIN_URL}/api/agents/mitzo-conversational/context`,
      { signal: expect.any(AbortSignal) },
    );

    expect(result).toEqual<BootContextMessage>({
      type: 'boot_context',
      source: 'contexgin',
      sourceCount: 2,
      tokenCount: 11297,
      tokenBudget: 11297,
      sources: [
        { path: 'CONSTITUTION.md', kind: 'reference' },
        { path: 'memory/Profile/Principles.md', kind: 'reference' },
      ],
      included: [],
      trimmed: [],
      fullMarkdown: '# Boot payload\nContext here.',
    });
  });

  it('returns local-fallback when ContexGin is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await fetchBootContext('mitzo-conversational', CONTEXGIN_URL);

    expect(result.source).toBe('local-fallback');
    expect(result.sourceCount).toBe(0);
    expect(result.tokenCount).toBe(0);
  });

  it('returns local-fallback on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => '{"error":"Agent not found"}',
    });

    const result = await fetchBootContext('nonexistent-agent', CONTEXGIN_URL);

    expect(result.source).toBe('local-fallback');
    expect(result.sourceCount).toBe(0);
  });

  it('returns local-fallback when response lacks boot field', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agent: 'test', identity: {} }),
    });

    const result = await fetchBootContext('mitzo-conversational', CONTEXGIN_URL);

    expect(result.source).toBe('local-fallback');
  });

  it('handles empty sources array', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        boot: { content: 'minimal', tokens: 100, sources: [] },
      }),
    });

    const result = await fetchBootContext('mitzo-conversational', CONTEXGIN_URL);

    expect(result.source).toBe('contexgin');
    expect(result.sourceCount).toBe(0);
    expect(result.sources).toEqual([]);
    expect(result.tokenCount).toBe(100);
  });

  it('filters non-string sources gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        boot: {
          content: 'payload',
          tokens: 500,
          sources: ['valid.md', null, 42, 'also-valid.md'],
        },
      }),
    });

    const result = await fetchBootContext('mitzo-conversational', CONTEXGIN_URL);

    expect(result.sources).toEqual([
      { path: 'valid.md', kind: 'reference' },
      { path: 'also-valid.md', kind: 'reference' },
    ]);
    expect(result.sourceCount).toBe(2);
  });

  it('uses default URL from env when not provided', async () => {
    const origUrl = process.env.CONTEXGIN_URL;
    process.env.CONTEXGIN_URL = 'http://test-host:9999';

    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    await fetchBootContext('mitzo-conversational');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://test-host:9999/api/agents/mitzo-conversational/context',
      expect.any(Object),
    );

    if (origUrl !== undefined) {
      process.env.CONTEXGIN_URL = origUrl;
    } else {
      delete process.env.CONTEXGIN_URL;
    }
  });
});

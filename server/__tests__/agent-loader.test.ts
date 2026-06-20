import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// Mock fs/promises.readFile for local file loading
const mockReadFile = vi.fn();
vi.mock('fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readFile: (...args: unknown[]) => mockReadFile(...args),
  };
});

// Mock js-yaml parser
const mockYamlParse = vi.fn();
vi.mock('js-yaml', () => ({
  load: (s: string) => mockYamlParse(s),
}));

const { loadAgentDef, clearCache } = await import('../agent-loader.js');

const VALID_CONTEXGIN_RESPONSE = {
  agent: 'mitzo-conversational',
  identity: {
    name: 'mitzo-conversational',
    description: 'Primary conversational assistant via Mitzo iOS',
    mode: 'dynamic',
  },
  provider: {
    default: 'claude-opus-4',
  },
  boot: {
    content: '# Boot payload',
    tokens: 12000,
    sources: ['CONSTITUTION.md'],
  },
  governance: {
    boundaries: [{ spoke: 'career', access: 'read' }],
    approval: { required_for: ['Bash'], auto_allow: ['Read', 'Write'] },
  },
  memory: { scope: 'read-write', vault: 'memory/' },
};

const VALID_LOCAL_YAML = {
  kind: 'AgentDefinition',
  version: '0.1',
  identity: {
    name: 'test-agent',
    description: 'A test agent',
    mode: 'narrow',
  },
  provider: { default: 'claude-sonnet-4' },
  context: { budget: 8000 },
  governance: {
    boundaries: [{ spoke: 'data', access: 'none' }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  clearCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadAgentDef', () => {
  describe('ContexGin source', () => {
    it('loads agent definition from ContexGin API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => VALID_CONTEXGIN_RESPONSE,
      });

      const result = await loadAgentDef(
        'mitzo-conversational',
        '/fake/cwd',
        'http://localhost:8321',
      );

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8321/api/agents/mitzo-conversational/context',
        { signal: expect.any(AbortSignal) },
      );

      expect(result.source).toBe('contexgin');
      expect(result.definition.identity.name).toBe('mitzo-conversational');
      expect(result.definition.identity.description).toBe(
        'Primary conversational assistant via Mitzo iOS',
      );
      expect(result.definition.governance).toEqual(VALID_CONTEXGIN_RESPONSE.governance);
      expect(result.definition.memory).toEqual(VALID_CONTEXGIN_RESPONSE.memory);
    });

    it('extracts token budget from boot.tokens', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => VALID_CONTEXGIN_RESPONSE,
      });

      const result = await loadAgentDef(
        'mitzo-conversational',
        '/fake/cwd',
        'http://localhost:8321',
      );

      expect(result.definition.context?.budget).toBe(12000);
    });
  });

  describe('local override source', () => {
    it('falls back to local .agents/ when ContexGin is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      mockReadFile.mockResolvedValueOnce('yaml content');
      mockYamlParse.mockReturnValueOnce(VALID_LOCAL_YAML);

      const result = await loadAgentDef('test-agent', '/workspace', 'http://localhost:8321');

      expect(result.source).toBe('local');
      expect(result.definition.identity.name).toBe('test-agent');
      expect(result.definition.identity.mode).toBe('narrow');
      expect(result.definition.context?.budget).toBe(8000);
      expect(result.definition.governance?.boundaries).toEqual([{ spoke: 'data', access: 'none' }]);
    });

    it('reads from correct local path', async () => {
      mockFetch.mockRejectedValueOnce(new Error('timeout'));
      mockReadFile.mockResolvedValueOnce('yaml');
      mockYamlParse.mockReturnValueOnce(VALID_LOCAL_YAML);

      await loadAgentDef('my-agent', '/my/workspace', 'http://localhost:8321');

      expect(mockReadFile).toHaveBeenCalledWith('/my/workspace/.agents/my-agent.yaml', 'utf-8');
    });
  });

  describe('bundled fallback', () => {
    it('returns DEFAULT_AGENT_DEFINITION when all sources fail', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

      const result = await loadAgentDef('mitzo-conversational', '/fake', 'http://localhost:8321');

      expect(result.source).toBe('fallback');
      expect(result.definition.identity.name).toBe('mitzo-conversational');
      expect(result.definition.identity.description).toContain('conversational assistant');
    });
  });

  describe('caching', () => {
    it('caches results and returns cached on second call', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => VALID_CONTEXGIN_RESPONSE,
      });

      const first = await loadAgentDef('mitzo-conversational', '/fake', 'http://localhost:8321');
      const second = await loadAgentDef('mitzo-conversational', '/fake', 'http://localhost:8321');

      expect(mockFetch).toHaveBeenCalledOnce(); // only one fetch
      expect(second).toBe(first); // same reference
    });

    it('uses separate cache keys per agent+cwd', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => VALID_CONTEXGIN_RESPONSE,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...VALID_CONTEXGIN_RESPONSE,
            identity: { ...VALID_CONTEXGIN_RESPONSE.identity, name: 'other-agent' },
          }),
        });

      await loadAgentDef('agent-a', '/cwd1', 'http://localhost:8321');
      await loadAgentDef('agent-b', '/cwd2', 'http://localhost:8321');

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('refetches after cache clear', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => VALID_CONTEXGIN_RESPONSE,
      });

      await loadAgentDef('mitzo-conversational', '/fake', 'http://localhost:8321');
      clearCache();
      await loadAgentDef('mitzo-conversational', '/fake', 'http://localhost:8321');

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('handles ContexGin 404 gracefully', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

      const result = await loadAgentDef('unknown', '/fake', 'http://localhost:8321');
      expect(result.source).toBe('fallback');
    });

    it('handles ContexGin response missing identity', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ boot: { tokens: 100 } }), // no identity
      });
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

      const result = await loadAgentDef('bad', '/fake', 'http://localhost:8321');
      expect(result.source).toBe('fallback');
    });

    it('handles malformed local YAML', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      mockReadFile.mockResolvedValueOnce('not: valid: yaml: {{');
      mockYamlParse.mockReturnValueOnce(null);

      const result = await loadAgentDef('bad', '/fake', 'http://localhost:8321');
      expect(result.source).toBe('fallback');
    });

    it('handles local YAML missing identity fields', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      mockReadFile.mockResolvedValueOnce('yaml');
      mockYamlParse.mockReturnValueOnce({ identity: { name: 'test' } }); // missing description

      const result = await loadAgentDef('bad', '/fake', 'http://localhost:8321');
      expect(result.source).toBe('fallback');
    });

    it('never throws — all errors result in fallback', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network error'));
      mockReadFile.mockImplementationOnce(() => {
        throw new Error('fs error');
      });

      // Should not throw
      const result = await loadAgentDef('anything', '/fake', 'http://localhost:8321');
      expect(result).toBeDefined();
      expect(result.source).toBe('fallback');
    });

    it.each([
      ['../evil', 'path traversal'],
      ['has.dot', 'dot in name'],
      ['-starts-with-dash', 'leading dash'],
      ['has spaces', 'spaces'],
      ['has/slash', 'slash'],
    ])('rejects invalid agent name %s (%s)', async (name, _reason) => {
      const result = await loadAgentDef(name, '/fake', 'http://localhost:8321');

      // Validation at entry point — no source attempted
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(result.source).toBe('fallback');
    });
  });

  describe('name normalization', () => {
    it('normalizes uppercase names from WS protocol', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => VALID_CONTEXGIN_RESPONSE,
      });

      await loadAgentDef('MyAgent', '/fake', 'http://localhost:8321');

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8321/api/agents/myagent/context', {
        signal: expect.any(AbortSignal),
      });
    });

    it('normalizes underscores to hyphens', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => VALID_CONTEXGIN_RESPONSE,
      });

      await loadAgentDef('my_agent', '/fake', 'http://localhost:8321');

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8321/api/agents/my-agent/context', {
        signal: expect.any(AbortSignal),
      });
    });

    it('normalizes mixed case + underscores', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => VALID_CONTEXGIN_RESPONSE,
      });

      await loadAgentDef('My_Agent_Name', '/fake', 'http://localhost:8321');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8321/api/agents/my-agent-name/context',
        { signal: expect.any(AbortSignal) },
      );
    });
  });

  describe('cache TTL expiration', () => {
    it('re-fetches after cache entry expires', async () => {
      vi.useFakeTimers();

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => VALID_CONTEXGIN_RESPONSE,
      });

      await loadAgentDef('mitzo-conversational', '/fake', 'http://localhost:8321');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance past 5-minute TTL
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      await loadAgentDef('mitzo-conversational', '/fake', 'http://localhost:8321');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  describe('chat.ts wiring contract', () => {
    // chat.ts fire-and-forget does: s.agentDefinition = loaded.definition;
    // s.agentDefinitionSource = loaded.source; — these tests verify the contract.

    it('ContexGin result has identity.description for session log line', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => VALID_CONTEXGIN_RESPONSE,
      });

      const result = await loadAgentDef('mitzo-conversational', '/fake', 'http://localhost:8321');

      // chat.ts logs: loaded.definition.identity.description
      expect(typeof result.definition.identity.description).toBe('string');
      expect(result.definition.identity.description.length).toBeGreaterThan(0);
    });

    it('fallback result has identity.description for session log line', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

      const result = await loadAgentDef('my-agent', '/fake', 'http://localhost:8321');

      expect(typeof result.definition.identity.description).toBe('string');
      expect(result.definition.identity.description.length).toBeGreaterThan(0);
    });

    it('source is always a valid AgentDefinitionSource', async () => {
      // ContexGin path
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => VALID_CONTEXGIN_RESPONSE,
      });
      const cg = await loadAgentDef('agent-a', '/fake', 'http://localhost:8321');
      expect(['contexgin', 'local', 'fallback']).toContain(cg.source);

      clearCache();

      // Fallback path
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      const fb = await loadAgentDef('agent-b', '/fake', 'http://localhost:8321');
      expect(['contexgin', 'local', 'fallback']).toContain(fb.source);
    });

    it('definition.provider always has a default model', async () => {
      // ContexGin with explicit provider
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => VALID_CONTEXGIN_RESPONSE,
      });
      const cg = await loadAgentDef('agent-a', '/fake', 'http://localhost:8321');
      expect(typeof cg.definition.provider.default).toBe('string');

      clearCache();

      // ContexGin without provider (should default)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          identity: { name: 'minimal', description: 'Minimal agent' },
        }),
      });
      const minimal = await loadAgentDef('agent-b', '/fake', 'http://localhost:8321');
      expect(typeof minimal.definition.provider.default).toBe('string');
    });
  });

  describe('concurrent requests', () => {
    it('both concurrent calls succeed even without deduplication', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => VALID_CONTEXGIN_RESPONSE,
      });

      const [a, b] = await Promise.all([
        loadAgentDef('mitzo-conversational', '/fake', 'http://localhost:8321'),
        loadAgentDef('mitzo-conversational', '/fake', 'http://localhost:8321'),
      ]);

      // Both get valid results — two fetches fire (no dedup yet)
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(a.source).toBe('contexgin');
      expect(b.source).toBe('contexgin');
    });
  });
});

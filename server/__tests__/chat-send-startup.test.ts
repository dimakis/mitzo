import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: vi.fn(),
}));
vi.mock('../session-index.js', async (original) => ({
  ...(await original<object>()),
  registerSession: vi.fn(),
}));
vi.mock('../prompt-compare.js', () => ({
  capturePromptComparison: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('makes an accepted session routable before boot completes and preserves its prompt identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-send-start-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ boot: { tokens: 1, fullMarkdown: 'boot' } })),
      ),
  );
  const chat = await import('../chat.js');
  const sessionId = '5f68a371-73d1-4994-a512-b71d4bc44c65';
  const events: Record<string, unknown>[] = [];
  vi.mocked(query).mockImplementation((args) => {
    expect(args.options?.sessionId).toBe(sessionId);
    return (async function* () {
      yield {
        type: 'assistant',
        session_id: sessionId,
        message: {
          id: 'answer',
          content: [{ type: 'text', text: 'response to first prompt' }],
          usage: {},
        },
      };
      yield {
        type: 'result',
        session_id: sessionId,
        subtype: 'success',
        usage: {},
        total_cost_usd: 0,
        num_turns: 1,
      };
    })() as ReturnType<typeof query>;
  });
  try {
    const running = chat.startChat(
      { send: (event) => events.push(event), isOpen: () => true },
      'stable-driver',
      'hello',
      {
        cwd: root,
        isolation: false,
        initialSessionId: sessionId,
        clientMsgId: 'original-prompt',
      },
    );
    expect(chat.registry.findBySessionId(sessionId)?.clientId).toBe('stable-driver');
    expect(
      chat.sendToChat('stable-driver', 'rapid follow-up', undefined, undefined, 'follow-up'),
    ).toBe(true);
    await running;
    expect(chat.eventStore.hasUserMessage(sessionId, 'original-prompt')).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'session_end', sessionId }));
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

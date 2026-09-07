import { expect, it, vi } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
import { AsyncQueue } from '../async-queue.js';
const calls = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  prompts: [] as string[],
  interrupt: vi.fn(),
}));
vi.mock('../native-responses-runner.js', () => ({
  NativeResponsesRunner: class {
    constructor(opts: Record<string, unknown>) {
      calls.options.push(opts);
    }
    async *run(prompt: string) {
      calls.prompts.push(prompt);
      yield { type: 'result', session_id: 'app' };
    }
    interrupt = calls.interrupt;
  },
}));
vi.mock('../codex-mcp-tools.js', () => ({
  connectCodexMcpTools: async () => ({
    definitions: [],
    close: async () => {},
    displayName: (name: string) => name,
  }),
}));
import { openResponsesChat } from '../responses-chat-session.js';

it('runs successive user turns with a private credential and closes its input queue', async () => {
  const registry = new SessionRegistry();
  const abort = new AbortController();
  registry.register('client', {
    transport: { send: () => {}, isOpen: () => true },
    abortController: abort,
    mode: 'agent',
    sessionId: 'app',
    cwd: '/tmp',
    sessionAllowList: new Set(),
  });
  const input = new AsyncQueue<{ message: { content: string } }>();
  input.push({ message: { content: 'first' } });
  input.push({ message: { content: 'second' } });
  input.close();
  const chat = await openResponsesChat({
    conversationId: 'app',
    binding: {
      accountId: 'work',
      accountLabel: 'Work',
      provider: 'openai',
      model: 'test',
      profileRevision: 'revision',
    },
    apiKey: 'private-test-key',
    session: registry.get('client')!,
    registry,
    input,
    systemPrompt: 'context',
    env: { PATH: '/usr/bin:/bin' },
    mcpServers: {},
    store: {} as never,
  });
  const events = [];
  for await (const event of chat) events.push(event);
  expect(calls.prompts).toEqual(['first', 'second']);
  expect(events[0]).toMatchObject({ type: 'system', session_id: 'app' });
  expect(JSON.stringify(events)).not.toContain('private-test-key');
  expect(calls.options[0].apiKey).toBe('private-test-key');
  expect(calls.options[0].tools).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'AskUserQuestion' })]),
  );
  registry.dispose();
});

it('does not start an API runner when a project startup hook fails', async () => {
  vi.stubEnv('MITZO_TRUST_PROJECT_HOOKS', '1');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'mitzo-startup-hook-'));
  mkdirSync(join(root, '.claude'));
  writeFileSync(
    join(root, '.claude/settings.json'),
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] },
    }),
  );
  const registry = new SessionRegistry();
  const abort = new AbortController();
  registry.register('client', {
    transport: { send: () => {}, isOpen: () => true },
    abortController: abort,
    mode: 'agent',
    sessionId: 'app',
    cwd: root,
    sessionAllowList: new Set(),
  });
  const count = calls.options.length;
  try {
    await expect(
      openResponsesChat({
        conversationId: 'app',
        binding: {
          accountId: 'work',
          accountLabel: 'Work',
          provider: 'openai',
          model: 'test',
          profileRevision: 'revision',
        },
        apiKey: 'private-test-key',
        session: registry.get('client')!,
        registry,
        input: new AsyncQueue(),
        systemPrompt: 'context',
        env: { PATH: '/usr/bin:/bin' },
        mcpServers: {},
        store: {} as never,
      }),
    ).rejects.toThrow('SessionStart hook failed');
    expect(calls.options).toHaveLength(count);
  } finally {
    vi.unstubAllEnvs();
    registry.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

import { expect, it, vi } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
import { AsyncQueue } from '../async-queue.js';
import { EventStore } from '../event-store.js';
import { admitProviderDispatch } from '../provider-execution.js';
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
      if (prompt === 'fail')
        throw Object.assign(new Error('OpenAI API request failed (429)'), {
          status: 429,
          code: 'rate_limit_error',
          retryAfter: '7',
          privateDiagnostic: 'Bearer sk-secret https://private.invalid',
        });
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

it('maps native OpenAI failures to the shared sanitized provider envelope', async () => {
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
  const input = new AsyncQueue<{
    message: { content: string };
    mitzoMessageId: string;
  }>();
  input.push({ message: { content: 'fail' }, mitzoMessageId: 'message-429' });
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
  expect(events.at(-1)).toMatchObject({
    type: 'result',
    session_id: 'app',
    is_error: true,
    provider_failure: {
      category: 'rate_limited',
      code: 'rate_limit_error',
      retryable: true,
      ambiguous: true,
      attempt: 1,
      correlationId: 'message-429',
      retryAfterMs: 7_000,
    },
  });
  expect(JSON.stringify(events)).not.toContain('sk-secret');
  expect(JSON.stringify(events)).not.toContain('private.invalid');
  registry.dispose();
});

it('dispatches an exact admitted command once and terminalizes provider state first', async () => {
  const registry = new SessionRegistry();
  const eventStore = new EventStore(':memory:');
  const abort = new AbortController();
  const promptCount = calls.prompts.length;
  registry.register('client', {
    transport: { send: () => {}, isOpen: () => true },
    abortController: abort,
    mode: 'agent',
    sessionId: 'app',
    cwd: '/tmp',
    sessionAllowList: new Set(),
  });
  eventStore.upsertSession({ sessionId: 'app' });
  const admission = admitProviderDispatch({
    store: eventStore,
    request: {
      sessionId: 'app',
      clientMsgId: 'message-once',
      effectivePrompt: 'once',
      model: 'test',
    },
    prepare: () => {},
  });
  const input = new AsyncQueue<{
    message: { content: string };
    mitzoMessageId: string;
    providerAdmission: typeof admission;
  }>();
  input.push({ message: { content: 'once' }, mitzoMessageId: 'message-once', providerAdmission: admission });
  input.push({ message: { content: 'once' }, mitzoMessageId: 'message-once', providerAdmission: admission });
  input.close();

  try {
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
      eventStore,
      systemPrompt: 'context',
      env: { PATH: '/usr/bin:/bin' },
      mcpServers: {},
      store: {} as never,
    });
    for await (const _event of chat) {
      // Drain the provider stream.
    }

    expect(calls.prompts.slice(promptCount)).toEqual(['once']);
    expect(eventStore.getProviderAttempts(admission.token)).toMatchObject([
      { phase: 'TERMINAL', terminalReason: 'completed' },
    ]);
    expect(eventStore.getSession('app')).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'completed',
    });
    expect(
      eventStore
        .getSessionEvents('app')
        .filter((event) => event.type.endsWith('_state_changed'))
        .map((event) => [event.type, event.payload.phase]),
    ).toEqual([
      ['execution_state_changed', 'RUNNING'],
      ['provider_attempt_state_changed', 'RUNNING'],
      ['provider_attempt_state_changed', 'TERMINAL'],
      ['execution_state_changed', 'TERMINAL'],
    ]);
  } finally {
    eventStore.close();
    registry.dispose();
  }
});

it('records an ambiguous provider failure before failing its execution', async () => {
  const registry = new SessionRegistry();
  const eventStore = new EventStore(':memory:');
  const abort = new AbortController();
  registry.register('client', {
    transport: { send: () => {}, isOpen: () => true },
    abortController: abort,
    mode: 'agent',
    sessionId: 'app',
    cwd: '/tmp',
    sessionAllowList: new Set(),
  });
  eventStore.upsertSession({ sessionId: 'app' });
  const admission = admitProviderDispatch({
    store: eventStore,
    request: {
      sessionId: 'app',
      clientMsgId: 'message-fail',
      effectivePrompt: 'fail',
      model: 'test',
    },
    prepare: () => {},
  });
  const input = new AsyncQueue<{
    message: { content: string };
    mitzoMessageId: string;
    providerAdmission: typeof admission;
  }>();
  input.push({ message: { content: 'fail' }, mitzoMessageId: 'message-fail', providerAdmission: admission });
  input.close();

  try {
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
      eventStore,
      systemPrompt: 'context',
      env: { PATH: '/usr/bin:/bin' },
      mcpServers: {},
      store: {} as never,
    });
    for await (const _event of chat) {
      // Drain the sanitized failure result.
    }

    expect(eventStore.getProviderAttempts(admission.token)).toMatchObject([
      { phase: 'TERMINAL', terminalReason: 'ambiguous' },
    ]);
    expect(eventStore.getSession('app')).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'failed',
    });
  } finally {
    eventStore.close();
    registry.dispose();
  }
});

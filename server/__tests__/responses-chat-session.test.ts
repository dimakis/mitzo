import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLibraryStore } from '../agent-library-store.js';
import { NativeResponsesStore } from '../native-responses-store.js';
import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { SessionRegistry } from '@mitzo/harness';
import { AsyncQueue } from '../async-queue.js';
import { EventStore } from '../event-store.js';
import { admitProviderDispatch } from '../provider-execution.js';
const calls = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  prompts: [] as unknown[],
  taskInput: {} as Record<string, unknown>,
  taskResults: [] as Array<{ content: string; is_error: boolean }>,
  interrupt: vi.fn(),
  releaseInterruptedRun: undefined as (() => void) | undefined,
}));
vi.mock('../native-responses-runner.js', () => ({
  NativeResponsesRunner: class {
    constructor(private readonly opts: Record<string, unknown>) {
      calls.options.push(opts);
    }
    async *run(prompt: unknown) {
      calls.prompts.push(prompt);
      if (prompt === 'task-route-proposal') {
        const execute = this.opts.executeTool as (
          block: unknown,
          signal: AbortSignal,
        ) => Promise<{ content: string; is_error: boolean }>;
        const block = {
          type: 'tool_use',
          id: 'task-provider-call',
          name: 'AgentProposeTask',
          input: calls.taskInput,
        };
        const signal = new AbortController().signal;
        calls.taskResults.push(await execute(block, signal));
        calls.taskResults.push(await execute(block, signal));
        const definition = calls.taskInput.definition as Record<string, unknown>;
        calls.taskResults.push(
          await execute(
            {
              ...block,
              input: {
                ...calls.taskInput,
                definition: { ...definition, name: 'Changed under same call' },
              },
            },
            signal,
          ),
        );
      }
      if (prompt === 'wait-for-interrupt') {
        await new Promise<void>((_, reject) => {
          calls.releaseInterruptedRun = () => reject(new Error('interrupted'));
        });
      }
      if (prompt === 'result-after-interrupt') {
        await new Promise<void>((resolve) => {
          calls.releaseInterruptedRun = resolve;
        });
      }
      if (typeof prompt === 'string' && prompt.startsWith('vertex-'))
        yield {
          type: 'stream_event',
          event: {
            type: 'message_start',
            message: { id: 'local-generated-id' },
            ...(prompt === 'vertex-remote-id'
              ? {
                  providerReceipt: {
                    provider: 'google-vertex',
                    responseId: 'remote-vertex-response',
                  },
                }
              : {}),
          },
        };
      if (prompt === 'provider-ack') {
        yield {
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'resp_exact' } },
        };
        yield {
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'resp_tool_followup' } },
        };
      }
      if (prompt === 'fail')
        throw Object.assign(new Error('OpenAI API request failed (429)'), {
          status: 429,
          code: 'rate_limit_error',
          retryAfter: '7',
          privateDiagnostic: 'Bearer sk-secret https://private.invalid',
        });
      if (prompt === 'fail-generic') throw new Error('Vertex transport failed');
      if (prompt === 'stream-then-close') {
        yield { type: 'assistant', session_id: 'app', message: { content: [] } };
      }
      yield { type: 'result', session_id: 'app' };
    }
    interrupt = () => {
      calls.interrupt();
      const release = calls.releaseInterruptedRun;
      setTimeout(() => release?.(), 10);
    };
    waitUntilIdle = async () => {};
  },
}));
vi.mock('../codex-mcp-tools.js', () => ({
  connectCodexMcpTools: vi.fn(async () => ({
    definitions: [],
    close: async () => {},
    displayName: (name: string) => name,
  })),
}));
import { openResponsesChat, trackResponsesProviderAdmission } from '../responses-chat-session.js';
import {
  CredentialConnections,
  CredentialConnectionStore,
  type ConnectionSender,
} from '../credential-connections.js';
import * as credentialRuntime from '../credential-connections-runtime.js';

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
  const getApiKey = vi.fn(async () => 'refreshed-test-key');
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
    getApiKey,
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
  expect(calls.options[0].getApiKey).toBe(getApiKey);
  expect(calls.options[0].systemPrompt).toContain('Execution location: Local host');
  expect(calls.options[0].systemPrompt).toContain(`Operating system: ${process.platform}`);
  expect(calls.options[0].systemPrompt).toContain(`Architecture: ${process.arch}`);
  expect(calls.options[0].systemPrompt).toContain('Working directory: "/tmp"');
  expect(calls.options[0].systemPrompt).toContain('Writable workspace roots: ["/tmp"]');
  expect(calls.options[0].tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'AskUserQuestion' }),
      expect.objectContaining({ name: 'RequestWebAccess' }),
      expect.objectContaining({ name: 'RequestGithubPublish' }),
      expect.objectContaining({ name: 'SymposiumProposeProfile' }),
      expect.objectContaining({ name: 'SymposiumReadProfiles' }),
      expect.objectContaining({ name: 'ReadKnowledge' }),
      expect.objectContaining({ name: 'SaveKnowledgeDraft' }),
    ]),
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

it.each([
  [true, true],
  [true, false],
  [false, true],
] as const)(
  'limits host command networking to explicit enrolled API sessions (enabled=%s, owned=%s)',
  async (enabled, owned) => {
    vi.stubEnv('MITZO_ORDINARY_LOCAL_RESPONSES_NETWORK_ENABLED', enabled ? '1' : '0');
    const native = await import('../native-tool-executor.js');
    const execute = vi.spyOn(native, 'createNativeToolExecutor').mockReturnValue(async (block) => ({
      type: 'tool_result',
      tool_use_id: block.id,
      content: 'offline command',
    }));
    const registry = new SessionRegistry();
    registry.register('network-client', {
      transport: { send: () => {}, isOpen: () => true },
      abortController: new AbortController(),
      mode: 'agent',
      sessionId: 'network-app',
      cwd: '/tmp',
      sessionAllowList: new Set(),
    });
    registry
      .get('network-client')!
      .worktreePaths.set('mitzo', { path: '/tmp/mitzo-worktree', wtId: 'fixture' });
    const input = new AsyncQueue<{ message: { content: string } }>();
    input.close();
    let chat: Awaited<ReturnType<typeof openResponsesChat>> | undefined;
    try {
      chat = await openResponsesChat({
        conversationId: 'network-app',
        binding: {
          accountId: 'work',
          accountLabel: 'Work',
          provider: 'openai',
          model: 'offline',
          profileRevision: 'fixture',
        },
        apiKey: 'synthetic-private-key',
        session: registry.get('network-client')!,
        registry,
        input,
        systemPrompt: 'profile',
        env: { PATH: '/usr/bin:/bin' },
        mcpServers: {},
        store: {} as never,
        ...(owned
          ? {
              commandAuthority: {
                assertEffect: vi.fn(async () => {}),
                assertPrepare: vi.fn(),
                assertStart: vi.fn(),
              },
              assertStartupCurrent: vi.fn(),
            }
          : {}),
      });
      const runner = calls.options.at(-1)!;
      const prompt = runner.systemPrompt as string;
      const allowed = enabled && owned;
      expect(prompt).toContain('Writable workspace roots: ["/tmp/mitzo-worktree"]');
      expect(prompt).toContain(
        allowed
          ? 'Bash networking: follows Mitzo command approvals'
          : 'Bash networking: unavailable',
      );
      expect(prompt).not.toContain('synthetic-private-key');
      const bash = (runner.tools as Array<{ name: string; description: string }>).find(
        (t) => t.name === 'Bash',
      )!;
      expect(bash.description).toContain(
        allowed
          ? 'Network access follows Mitzo command approvals'
          : 'Network and credentials are unavailable',
      );
      await (runner.executeTool as (block: unknown, signal: AbortSignal) => Promise<unknown>)(
        { type: 'tool_use', id: 'network-call', name: 'Bash', input: { command: 'npm install' } },
        new AbortController().signal,
      );
      expect(execute).toHaveBeenCalledWith(
        'network-client',
        registry,
        expect.objectContaining({ networkAccess: allowed ? 'approved-command' : undefined }),
      );
    } finally {
      chat?.close();
      registry.dispose();
      execute.mockRestore();
      vi.unstubAllEnvs();
    }
  },
);

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
  input.push({
    message: { content: 'once' },
    mitzoMessageId: 'message-once',
    providerAdmission: admission,
  });
  input.push({
    message: { content: 'once' },
    mitzoMessageId: 'message-once',
    providerAdmission: admission,
  });
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
    for await (const event of chat) {
      // Drain the provider stream.
      void event;
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
  input.push({
    message: { content: 'fail' },
    mitzoMessageId: 'message-fail',
    providerAdmission: admission,
  });
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
    for await (const event of chat) {
      // Drain the sanitized failure result.
      void event;
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

it('terminalizes an admitted command that is aborted before provider dispatch', async () => {
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
      clientMsgId: 'message-abort',
      effectivePrompt: 'queued',
      model: 'test',
    },
    prepare: () => {},
  });
  const input = new AsyncQueue<{
    message: { content: string };
    providerAdmission: typeof admission;
  }>();
  input.push({ message: { content: 'queued' }, providerAdmission: admission });

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
    abort.abort();
    await expect(async () => {
      for await (const event of chat) void event;
    }).rejects.toThrow();
    expect(eventStore.getProviderAttempts(admission.token)).toEqual([]);
    expect(eventStore.getSession('app')).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'interrupted',
    });
  } finally {
    eventStore.close();
    registry.dispose();
  }
});

it('waits for durable cancellation before interrupt resolves', async () => {
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
      clientMsgId: 'message-interrupt',
      effectivePrompt: 'wait-for-interrupt',
      model: 'test',
    },
    prepare: () => {},
  });
  const input = new AsyncQueue<{
    message: { content: string };
    providerAdmission: typeof admission;
  }>();
  input.push({ message: { content: 'wait-for-interrupt' }, providerAdmission: admission });

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
    const draining = (async () => {
      for await (const event of chat) void event;
    })();
    await vi.waitFor(() => expect(calls.releaseInterruptedRun).toBeTypeOf('function'));
    await chat.interrupt();
    expect(eventStore.getSession('app')).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'interrupted',
    });
    input.close();
    await draining;
  } finally {
    calls.releaseInterruptedRun = undefined;
    eventStore.close();
    registry.dispose();
  }
});

it('cancels an admitted command when interrupted before dequeue', async () => {
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
  const session = registry.get('client')!;
  eventStore.upsertSession({ sessionId: 'app' });
  const admission = admitProviderDispatch({
    store: eventStore,
    request: {
      sessionId: 'app',
      clientMsgId: 'message-queued-interrupt',
      effectivePrompt: 'queued-interrupt',
      model: 'test',
    },
    prepare: () => {},
  });
  const input = new AsyncQueue<{
    message: { content: string };
    providerAdmission: typeof admission;
  }>();
  input.push({ message: { content: 'queued-interrupt' }, providerAdmission: admission });

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
      session,
      registry,
      input,
      eventStore,
      systemPrompt: 'context',
      env: { PATH: '/usr/bin:/bin' },
      mcpServers: {},
      store: {} as never,
    });
    trackResponsesProviderAdmission(session, admission, eventStore);
    await chat.interrupt();
    expect(eventStore.getSession('app')).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'interrupted',
    });
    input.close();
    for await (const event of chat) void event;
    expect(calls.prompts).not.toContain('queued-interrupt');
  } finally {
    eventStore.close();
    registry.dispose();
  }
});

it('records ordinary non-OpenAI failures as failed executions', async () => {
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
      clientMsgId: 'message-vertex-fail',
      effectivePrompt: 'fail-generic',
      model: 'test',
    },
    prepare: () => {},
  });
  const input = new AsyncQueue<{
    message: { content: string };
    providerAdmission: typeof admission;
  }>();
  input.push({ message: { content: 'fail-generic' }, providerAdmission: admission });
  input.close();

  try {
    const chat = await openResponsesChat({
      conversationId: 'app',
      binding: {
        accountId: 'work',
        accountLabel: 'Work',
        provider: 'google-vertex',
        model: 'test',
        profileRevision: 'revision',
      },
      gemini: {
        accountId: 'work',
        projectId: 'project',
        region: 'global',
        getAccessToken: async () => 'token',
      },
      session: registry.get('client')!,
      registry,
      input,
      eventStore,
      systemPrompt: 'context',
      env: { PATH: '/usr/bin:/bin' },
      mcpServers: {},
      store: {} as never,
    });
    await expect(async () => {
      for await (const event of chat) void event;
    }).rejects.toThrow();
    expect(eventStore.getSession('app')).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'failed',
    });
  } finally {
    eventStore.close();
    registry.dispose();
  }
});

it('terminalizes an active provider attempt when its consumer closes the stream', async () => {
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
      clientMsgId: 'message-consumer-close',
      effectivePrompt: 'stream-then-close',
      model: 'test',
    },
    prepare: () => {},
  });
  const input = new AsyncQueue<{
    message: { content: string };
    providerAdmission: typeof admission;
  }>();
  input.push({ message: { content: 'stream-then-close' }, providerAdmission: admission });

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
    for await (const event of chat) {
      if (event.type === 'assistant') break;
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

it('terminalizes a queued execution when provider-attempt startup fails', async () => {
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
  const session = registry.get('client')!;
  eventStore.upsertSession({ sessionId: 'app' });
  const admission = admitProviderDispatch({
    store: eventStore,
    request: {
      sessionId: 'app',
      clientMsgId: 'message-attempt-startup-fail',
      effectivePrompt: 'attempt-startup-fail',
      model: 'test',
    },
    prepare: () => {},
  });
  const input = new AsyncQueue<{
    message: { content: string };
    providerAdmission: typeof admission;
  }>();
  input.push({ message: { content: 'attempt-startup-fail' }, providerAdmission: admission });

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
      session,
      registry,
      input,
      eventStore,
      systemPrompt: 'context',
      env: { PATH: '/usr/bin:/bin' },
      mcpServers: {},
      store: {} as never,
    });
    trackResponsesProviderAdmission(session, admission, eventStore);
    vi.spyOn(eventStore, 'beginProviderAttempt').mockImplementationOnce(() => {
      throw new Error('provider attempt storage failed');
    });

    await expect(async () => {
      for await (const event of chat) void event;
    }).rejects.toThrow('provider attempt storage failed');
    expect(eventStore.getSession('app')).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'interrupted',
    });
  } finally {
    eventStore.close();
    registry.dispose();
  }
});

it('releases interrupt waiters when durable terminalization throws', async () => {
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
      clientMsgId: 'message-terminalization-fail',
      effectivePrompt: 'wait-for-interrupt',
      model: 'test',
    },
    prepare: () => {},
  });
  const input = new AsyncQueue<{
    message: { content: string };
    providerAdmission: typeof admission;
  }>();
  input.push({ message: { content: 'wait-for-interrupt' }, providerAdmission: admission });

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
    const draining = (async () => {
      for await (const event of chat) void event;
    })();
    const drainOutcome = draining.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(calls.releaseInterruptedRun).toBeTypeOf('function'));
    vi.spyOn(eventStore, 'transitionProviderAttempt').mockImplementation(() => {
      throw new Error('provider terminalization storage failed');
    });

    const interruptOutcome = Promise.race([
      chat.interrupt().then(() => 'resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
    ]);
    await expect(interruptOutcome).resolves.toBe('resolved');
    await expect(drainOutcome).resolves.toEqual(
      expect.objectContaining({ message: 'provider terminalization storage failed' }),
    );
  } finally {
    calls.releaseInterruptedRun = undefined;
    eventStore.close();
    registry.dispose();
  }
});

it('keeps provider completion but fails execution when the Stop hook fails', async () => {
  vi.stubEnv('MITZO_TRUST_PROJECT_HOOKS', '1');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'mitzo-stop-hook-'));
  mkdirSync(join(root, '.claude'));
  writeFileSync(
    join(root, '.claude/settings.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] } }),
  );
  const registry = new SessionRegistry();
  const eventStore = new EventStore(':memory:');
  const abort = new AbortController();
  registry.register('client', {
    transport: { send: () => {}, isOpen: () => true },
    abortController: abort,
    mode: 'agent',
    sessionId: 'app',
    cwd: root,
    sessionAllowList: new Set(),
  });
  eventStore.upsertSession({ sessionId: 'app' });
  const admission = admitProviderDispatch({
    store: eventStore,
    request: {
      sessionId: 'app',
      clientMsgId: 'message-stop-hook-fail',
      effectivePrompt: 'stop-hook-fail',
      model: 'test',
    },
    prepare: () => {},
  });
  const input = new AsyncQueue<{
    message: { content: string };
    providerAdmission: typeof admission;
  }>();
  input.push({ message: { content: 'stop-hook-fail' }, providerAdmission: admission });
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
    for await (const event of chat) void event;

    expect(eventStore.getProviderAttempts(admission.token)).toMatchObject([
      { phase: 'TERMINAL', terminalReason: 'completed' },
    ]);
    expect(eventStore.getSession('app')).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'failed',
    });
  } finally {
    vi.unstubAllEnvs();
    eventStore.close();
    registry.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it('records cancellation when the runner emits a result after interrupt', async () => {
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
      clientMsgId: 'message-result-after-interrupt',
      effectivePrompt: 'result-after-interrupt',
      model: 'test',
    },
    prepare: () => {},
  });
  const input = new AsyncQueue<{
    message: { content: string };
    providerAdmission: typeof admission;
  }>();
  input.push({ message: { content: 'result-after-interrupt' }, providerAdmission: admission });

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
    const emitted: Record<string, unknown>[] = [];
    const draining = (async () => {
      for await (const event of chat) emitted.push(event);
    })();
    await vi.waitFor(() => expect(calls.releaseInterruptedRun).toBeTypeOf('function'));
    await chat.interrupt();
    input.close();
    await draining;

    expect(emitted.find((event) => event.type === 'result')).toMatchObject({
      account_use_cancelled: true,
    });
    expect(eventStore.getProviderAttempts(admission.token)).toMatchObject([
      { phase: 'TERMINAL', terminalReason: 'cancelled' },
    ]);
    expect(eventStore.getSession('app')).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'interrupted',
    });
  } finally {
    calls.releaseInterruptedRun = undefined;
    eventStore.close();
    registry.dispose();
  }
});

it.each(['interrupt', 'abort'] as const)(
  'marks account use cancelled when %s occurs during the Stop hook',
  async (cancellation) => {
    const { NativeHooks } = await import('../native-hooks.js');
    const originalRun = NativeHooks.prototype.run;
    let releaseStop!: () => void;
    let stopStarted = false;
    const hook = vi.spyOn(NativeHooks.prototype, 'run').mockImplementation(function (
      this: InstanceType<typeof NativeHooks>,
      ...args
    ) {
      if (args[0] !== 'Stop') return originalRun.apply(this, args);
      stopStarted = true;
      return new Promise((resolve) => {
        releaseStop = () => resolve({ context: '', forcePrompt: false });
      });
    });
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
        clientMsgId: 'message-stop-interrupt',
        effectivePrompt: 'completed-before-stop',
        model: 'test',
      },
      prepare: () => {},
    });
    const input = new AsyncQueue<{
      message: { content: string };
      providerAdmission: typeof admission;
    }>();
    input.push({ message: { content: 'completed-before-stop' }, providerAdmission: admission });

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
      const emitted: Record<string, unknown>[] = [];
      const draining = (async () => {
        for await (const event of chat) emitted.push(event);
      })();
      await vi.waitFor(() => expect(stopStarted).toBe(true));
      const pendingInterrupt = cancellation === 'interrupt' ? chat.interrupt() : undefined;
      if (cancellation === 'abort') abort.abort();
      releaseStop();
      await pendingInterrupt;
      input.close();
      await draining;

      expect(emitted.find((event) => event.type === 'result')).toMatchObject({
        account_use_cancelled: true,
      });
      expect(eventStore.getProviderAttempts(admission.token)).toMatchObject([
        { phase: 'TERMINAL', terminalReason: 'completed' },
      ]);
      expect(eventStore.getSession('app')).toMatchObject({
        executionPhase: 'TERMINAL',
        executionTerminalReason: 'interrupted',
      });
    } finally {
      releaseStop?.();
      hook.mockRestore();
      eventStore.close();
      registry.dispose();
    }
  },
);

it('interrupts the runtime even when queued cancellation persistence fails', async () => {
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
  const session = registry.get('client')!;
  eventStore.upsertSession({ sessionId: 'app' });
  const admission = admitProviderDispatch({
    store: eventStore,
    request: {
      sessionId: 'app',
      clientMsgId: 'message-cancel-storage-fail',
      effectivePrompt: 'queued',
      model: 'test',
    },
    prepare: () => {},
  });
  const input = new AsyncQueue<{
    message: { content: string };
    providerAdmission: typeof admission;
  }>();
  input.push({ message: { content: 'queued' }, providerAdmission: admission });

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
      session,
      registry,
      input,
      eventStore,
      systemPrompt: 'context',
      env: { PATH: '/usr/bin:/bin' },
      mcpServers: {},
      store: {} as never,
    });
    trackResponsesProviderAdmission(session, admission, eventStore);
    vi.spyOn(eventStore, 'transitionExecution').mockImplementationOnce(() => {
      throw new Error('cancellation storage failed');
    });
    const interruptCount = calls.interrupt.mock.calls.length;
    const promptCount = calls.prompts.length;

    await expect(chat.interrupt()).rejects.toThrow('cancellation storage failed');
    expect(calls.interrupt).toHaveBeenCalledTimes(interruptCount + 1);
    await expect(chat.interrupt()).resolves.toBeUndefined();
    expect(eventStore.getSession('app')).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'interrupted',
    });
    input.close();
    for await (const event of chat) void event;
    expect(calls.prompts).toHaveLength(promptCount);
  } finally {
    registry.dispose();
    eventStore.close();
  }
});

it('keeps close no-throw when queued cancellation persistence fails', async () => {
  const registry = new SessionRegistry();
  const eventStore = new EventStore(':memory:');
  registry.register('client', {
    transport: { send: () => {}, isOpen: () => true },
    abortController: new AbortController(),
    mode: 'agent',
    sessionId: 'app',
    cwd: '/tmp',
    sessionAllowList: new Set(),
  });
  const session = registry.get('client')!;
  eventStore.upsertSession({ sessionId: 'app' });
  const admission = admitProviderDispatch({
    store: eventStore,
    request: {
      sessionId: 'app',
      clientMsgId: 'message-close-storage-fail',
      effectivePrompt: 'queued',
      model: 'test',
    },
    prepare: () => {},
  });
  const input = new AsyncQueue<{
    message: { content: string };
    providerAdmission: typeof admission;
  }>();
  input.push({ message: { content: 'queued' }, providerAdmission: admission });

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
      session,
      registry,
      input,
      eventStore,
      systemPrompt: 'context',
      env: { PATH: '/usr/bin:/bin' },
      mcpServers: {},
      store: {} as never,
    });
    trackResponsesProviderAdmission(session, admission, eventStore);
    vi.spyOn(eventStore, 'transitionExecution').mockImplementationOnce(() => {
      throw new Error('cancellation storage failed');
    });
    const interruptCount = calls.interrupt.mock.calls.length;

    expect(() => chat.close()).not.toThrow();
    expect(calls.interrupt).toHaveBeenCalledTimes(interruptCount + 1);
  } finally {
    registry.dispose();
    eventStore.close();
  }
});

it.each(['provider-ack', 'fail', 'stream-then-close'])(
  'records profile context delivery only after real provider message start (%s)',
  async (prompt) => {
    const registry = new SessionRegistry();
    const abortController = new AbortController();
    registry.register('receipt-client', {
      transport: { send: () => {}, isOpen: () => true },
      abortController,
      mode: 'agent',
      sessionId: 'receipt-app',
      cwd: '/tmp',
      sessionAllowList: new Set(),
    });
    const input = new AsyncQueue<{ message: { content: string }; mitzoMessageId: string }>();
    input.push({ message: { content: prompt }, mitzoMessageId: 'exact-command' });
    input.close();
    const accepted = vi.fn();
    const chat = await openResponsesChat({
      conversationId: 'receipt-app',
      binding: {
        accountId: 'fixture',
        accountLabel: 'Fixture',
        provider: 'openai',
        model: 'offline',
        profileRevision: 'fixture',
      },
      apiKey: 'mock-only',
      session: registry.get('receipt-client')!,
      registry,
      input,
      systemPrompt: 'Pinned profile boot context',
      env: { PATH: '/usr/bin:/bin' },
      mcpServers: {},
      store: {} as never,
      onAgentContextAccepted: accepted,
    });
    try {
      const iterator = chat[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ type: 'system', subtype: 'init' });
      expect(accepted).not.toHaveBeenCalled();
      while (!(await iterator.next()).done) {
        /* Drain the mocked provider stream. */
      }
      if (prompt === 'provider-ack') {
        expect(accepted).toHaveBeenCalledOnce();
        expect(accepted).toHaveBeenCalledWith(
          'exact-command',
          'receipt-app',
          'resp_exact',
          createHash('sha256')
            .update(calls.options.at(-1)!.systemPrompt as string)
            .digest('hex'),
        );
      } else expect(accepted).not.toHaveBeenCalled();
    } finally {
      chat.close();
      registry.dispose();
    }
  },
);

it.each(['vertex-remote-id', 'vertex-local-id'])(
  'requires actual Vertex provider receipt metadata (%s)',
  async (prompt) => {
    const registry = new SessionRegistry();
    const abortController = new AbortController();
    registry.register('vertex-client', {
      transport: { send: () => {}, isOpen: () => true },
      abortController,
      mode: 'agent',
      sessionId: 'vertex-app',
      cwd: '/tmp',
      sessionAllowList: new Set(),
    });
    const input = new AsyncQueue<{ message: { content: string }; mitzoMessageId: string }>();
    input.push({ message: { content: prompt }, mitzoMessageId: 'vertex-command' });
    input.close();
    const accepted = vi.fn();
    const chat = await openResponsesChat({
      conversationId: 'vertex-app',
      binding: {
        accountId: 'fixture',
        accountLabel: 'Fixture',
        provider: 'google-vertex',
        model: 'gemini-3.8-flash',
        profileRevision: 'fixture',
      },
      gemini: {
        accountId: 'fixture',
        projectId: 'fixture',
        region: 'global',
        getAccessToken: async () => {
          throw Error('No live credentials');
        },
      },
      session: registry.get('vertex-client')!,
      registry,
      input,
      systemPrompt: 'Pinned vertex context',
      env: { PATH: '/usr/bin:/bin' },
      mcpServers: {},
      store: {} as never,
      onAgentContextAccepted: accepted,
    });
    try {
      for await (const event of chat) {
        expect(event).toHaveProperty('type');
      }
      if (prompt === 'vertex-remote-id')
        expect(accepted).toHaveBeenCalledWith(
          'vertex-command',
          'vertex-app',
          'remote-vertex-response',
          createHash('sha256')
            .update(calls.options.at(-1)!.systemPrompt as string)
            .digest('hex'),
        );
      else expect(accepted).not.toHaveBeenCalled();
    } finally {
      chat.close();
      registry.dispose();
    }
  },
);

it('revalidates source authority on later queued API commands before starting the runner', async () => {
  const registry = new SessionRegistry();
  const abortController = new AbortController();
  registry.register('scope-client', {
    transport: { send: () => {}, isOpen: () => true },
    abortController,
    mode: 'agent',
    sessionId: 'scope-app',
    cwd: '/tmp',
    sessionAllowList: new Set(),
  });
  const input = new AsyncQueue<{ message: { content: string }; mitzoMessageId: string }>();
  input.push({ message: { content: 'provider-ack' }, mitzoMessageId: 'accepted-command' });
  input.push({ message: { content: 'second-denied' }, mitzoMessageId: 'denied-command' });
  input.close();
  let checks = 0;
  const authorize = vi.fn(async () => {
    if (++checks > 1) throw Error('Source grant revoked');
  });
  const accepted = vi.fn();
  const prior = calls.prompts.length;
  const chat = await openResponsesChat({
    conversationId: 'scope-app',
    binding: {
      accountId: 'fixture',
      accountLabel: 'Fixture',
      provider: 'openai',
      model: 'offline',
      profileRevision: 'fixture',
    },
    apiKey: 'offline-only',
    session: registry.get('scope-client')!,
    registry,
    input,
    systemPrompt: 'Pinned scope context',
    env: { PATH: '/usr/bin:/bin' },
    mcpServers: {},
    store: {} as never,
    prepareAgentContext: authorize,
    onAgentContextAccepted: accepted,
  });
  try {
    for await (const event of chat) expect(event).toHaveProperty('type');
    expect(calls.prompts.slice(prior)).toEqual(['provider-ack']);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(accepted).toHaveBeenCalledOnce();
  } finally {
    chat.close();
    registry.dispose();
  }
});

it.each(['Describe this', ''])(
  'converts image turns and image follow-ups into runner content (%j)',
  async (prompt) => {
    const registry = new SessionRegistry();
    registry.register('image-client', {
      transport: { send: () => {}, isOpen: () => true },
      abortController: new AbortController(),
      mode: 'agent',
      sessionId: 'image-app',
      cwd: '/tmp',
      sessionAllowList: new Set(),
    });
    const input = new AsyncQueue<{
      message: { content: string };
      mitzoImages?: Array<{ data: string; mediaType: string }>;
    }>();
    const image = { data: 'aGk=', mediaType: 'image/png' };
    input.push({ message: { content: prompt }, mitzoImages: [image] });
    input.push({ message: { content: 'plain follow-up' } });
    input.push({ message: { content: 'Compare again' }, mitzoImages: [image] });
    input.close();
    const prior = calls.prompts.length;
    try {
      const chat = await openResponsesChat({
        conversationId: 'image-app',
        binding: {
          accountId: 'fixture',
          accountLabel: 'Fixture',
          provider: 'openai',
          model: 'offline',
          profileRevision: 'fixture',
        },
        apiKey: 'mock-only',
        session: registry.get('image-client')!,
        registry,
        input,
        systemPrompt: 'context',
        env: { PATH: '/usr/bin:/bin' },
        mcpServers: {},
        store: {} as never,
      });
      for await (const event of chat) expect(event).toHaveProperty('type');
      const block = {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
      };
      expect(calls.prompts.slice(prior)).toEqual([
        [...(prompt ? [{ type: 'text', text: prompt }] : []), block],
        'plain follow-up',
        [{ type: 'text', text: 'Compare again' }, block],
      ]);
    } finally {
      registry.dispose();
    }
  },
);

it.each([
  {
    provider: 'openai' as const,
    content: [{ type: 'text', text: 'SDK content' }],
    images: undefined,
    error: /string/i,
  },
  {
    provider: 'openai' as const,
    content: '',
    images: [{ data: 'not base64', mediaType: 'image/png' }],
    error: /base64/i,
  },
  {
    provider: 'google-vertex' as const,
    content: 'See this',
    images: [{ data: 'aGk=', mediaType: 'image/png' }],
    error: /Vertex.*image/i,
  },
])(
  'rejects unsupported queued content before runner dispatch ($provider)',
  async ({ provider, content, images, error }) => {
    const registry = new SessionRegistry();
    registry.register('invalid-image-client', {
      transport: { send: () => {}, isOpen: () => true },
      abortController: new AbortController(),
      mode: 'agent',
      sessionId: 'invalid-image-app',
      cwd: '/tmp',
      sessionAllowList: new Set(),
    });
    const input = new AsyncQueue<{
      message: { content: unknown };
      mitzoImages?: Array<{ data: string; mediaType: string }>;
    }>();
    input.push({ message: { content }, mitzoImages: images });
    input.close();
    const prior = calls.prompts.length;
    try {
      const chat = await openResponsesChat({
        conversationId: 'invalid-image-app',
        binding: {
          accountId: 'fixture',
          accountLabel: 'Fixture',
          provider,
          model: 'offline',
          profileRevision: 'fixture',
        },
        apiKey: 'mock-only',
        session: registry.get('invalid-image-client')!,
        registry,
        input,
        systemPrompt: 'context',
        env: { PATH: '/usr/bin:/bin' },
        mcpServers: {},
        store: {} as never,
      });
      await expect(
        (async () => {
          for await (const event of chat) void event;
        })(),
      ).rejects.toThrow(error);
      expect(calls.prompts).toHaveLength(prior);
    } finally {
      registry.dispose();
    }
  },
);

it('API tool dispatch persists profile proposals with the provider call identity', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { SymposiumProfileProposalStore } = await import('../symposium-profile-proposals.js');
  const root = mkdtempSync(join(tmpdir(), 'profile-api-'));
  vi.stubEnv('REPO_PATH', root);
  const registry = new SessionRegistry();
  registry.register('client', {
    transport: { send() {}, isOpen: () => true },
    abortController: new AbortController(),
    mode: 'agent',
    sessionId: 'profile-chat',
    cwd: root,
    sessionAllowList: new Set(),
  });
  const input = new AsyncQueue<{ message: { content: string } }>();
  input.close();
  try {
    const chat = await openResponsesChat({
      conversationId: 'profile-chat',
      binding: {
        accountId: 'fixture',
        accountLabel: 'Offline fixture',
        provider: 'openai',
        model: 'fixture',
        profileRevision: 'r1',
      },
      apiKey: 'offline-fixture',
      session: registry.get('client')!,
      registry,
      input,
      systemPrompt: '',
      env: { PATH: '/usr/bin:/bin' },
      mcpServers: {},
      store: {} as never,
    });
    const execute = calls.options.at(-1)!.executeTool as (
      block: unknown,
      signal: AbortSignal,
    ) => Promise<{ content: string; is_error: boolean }>;
    const block = {
      id: 'provider-call',
      name: 'SymposiumProposeProfile',
      input: {
        definition: {
          name: 'Trace',
          role: 'agent',
          instructions: 'Diagnose',
          expectedOutput: 'Diagnosis',
          acceptanceCriteria: ['Evidence'],
          modelPolicyRole: 'agent',
        },
      },
    };
    const first = await execute(block, new AbortController().signal);
    expect(first.is_error).toBe(false);
    expect(await execute(block, new AbortController().signal)).toEqual(first);
    const store = new SymposiumProfileProposalStore(join(root, '.mitzo', 'events.db'));
    try {
      expect(store.listPending('user', 'profile-chat')).toHaveLength(1);
    } finally {
      store.close();
    }
    for await (const event of chat) {
      expect(event).toBeDefined();
    }
  } finally {
    registry.dispose();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it('gives API chats a Jira connection route even when workspace context recommends the CLI', async () => {
  const registry = new SessionRegistry();
  registry.register('jira-client', {
    transport: { send() {}, isOpen: () => true },
    abortController: new AbortController(),
    mode: 'agent',
    sessionId: 'jira-chat',
    cwd: '/tmp',
    sessionAllowList: new Set(),
  });
  const input = new AsyncQueue<{ message: { content: string } }>();
  input.close();
  const chat = await openResponsesChat({
    conversationId: 'jira-chat',
    binding: {
      accountId: 'offline',
      accountLabel: 'Offline',
      provider: 'openai',
      model: 'offline',
      profileRevision: 'fixture',
    },
    apiKey: 'mock-only',
    session: registry.get('jira-client')!,
    registry,
    input,
    systemPrompt: 'For Jira run ./mgmt jira strats',
    env: { PATH: '/usr/bin:/bin' },
    mcpServers: {},
    store: {} as never,
  });
  try {
    const options = calls.options.at(-1)!;
    expect(options.systemPrompt).toContain(
      'Shared ./mgmt jira guidance applies to the OpenShell transport',
    );
    expect(options.systemPrompt).toContain('Bash networking: unavailable');
    expect(options.systemPrompt).toContain('API Bash never receives connection credentials');
    expect((options.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'ListConnections',
        'RequestConnectionAccess',
        'ConnectionRequest',
        'PrepareConnectionSetup',
      ]),
    );
  } finally {
    chat.close();
    registry.dispose();
  }
});

it.each(['agent', 'ask'] as const)(
  'dispatches Jira reads through the API connection tools in %s mode',
  async (mode) => {
    const store = new CredentialConnectionStore(':memory:');
    const vault = {
      save: vi.fn(async () => ({ service: 'fixture', account: 'fixture' })),
      read: vi.fn(async () => 'jira-private-token'),
      link: vi.fn(),
      remove: vi.fn(async () => {}),
    };
    const send = vi.fn<ConnectionSender>(async () => ({
      status: 200,
      body: '{"issues":[{"key":"TEST-1"}],"isLast":true}',
    }));
    const service = new CredentialConnections(store, vault, send);
    const runtime = vi
      .spyOn(credentialRuntime, 'getCredentialConnectionsRuntime')
      .mockReturnValue(service);
    const registry = new SessionRegistry();
    registry.register('jira-read-client', {
      transport: { send() {}, isOpen: () => true },
      mode,
      sessionId: 'jira-read-chat',
      cwd: '/tmp',
      abortController: new AbortController(),
      sessionAllowList: new Set(),
    });
    const connection = await service.create(
      {
        label: 'Jira',
        endpoint: 'https://team.atlassian.net',
        auth: { kind: 'basic', username: 'reader@example.com' },
        paths: ['/rest/api/3/'],
        methods: ['GET', 'HEAD'],
      },
      { secret: 'jira-private-token' },
    );
    service.grant('jira-read-chat', connection.id, connection.revision);
    const { bindAgentToolSelection } = await import('../agent-tool-selection.js');
    bindAgentToolSelection(registry.get('jira-read-client')!, {
      tools: ['ListConnections', 'RequestConnectionAccess', 'ConnectionRequest'].map((name) => ({
        id: `mitzo:${name}`,
        version: 1,
      })),
    } as never);
    const input = new AsyncQueue<{ message: { content: string } }>();
    input.close();
    const chat = await openResponsesChat({
      conversationId: 'jira-read-chat',
      binding: {
        accountId: 'offline',
        accountLabel: 'Offline',
        provider: 'openai',
        model: 'offline',
        profileRevision: 'fixture',
      },
      apiKey: 'mock-only',
      session: registry.get('jira-read-client')!,
      registry,
      input,
      systemPrompt: '',
      env: { PATH: '/usr/bin:/bin' },
      mcpServers: {},
      store: {} as never,
    });
    try {
      const execute = calls.options.at(-1)!.executeTool as (
        block: unknown,
        signal: AbortSignal,
      ) => Promise<{ content: string; is_error: boolean }>;
      const signal = new AbortController().signal;
      const listed = await execute({ id: 'list', name: 'ListConnections', input: {} }, signal);
      expect(JSON.parse(listed.content).connections).toContainEqual(
        expect.objectContaining({
          id: connection.id,
          transport: 'keychain-https',
          access: 'approved',
        }),
      );
      const read = {
        id: 'read',
        name: 'ConnectionRequest',
        input: {
          connectionId: connection.id,
          path: '/rest/api/3/search/jql?jql=assignee%3DcurrentUser()',
          method: 'GET',
        },
      };
      const result = await execute(read, signal);
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('TEST-1');
      expect(result.content).not.toContain('jira-private-token');
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0][0]).toMatchObject({
        headers: {
          Authorization: `Basic ${Buffer.from('reader@example.com:jira-private-token').toString('base64')}`,
        },
      });
      service.disable(connection.id, connection.revision);
      expect((await execute(read, signal)).is_error).toBe(true);
      expect(send).toHaveBeenCalledOnce();
    } finally {
      chat.close();
      registry.dispose();
      runtime.mockRestore();
      store.close();
    }
  },
);

it.each(['openai', 'google-vertex'] as const)(
  'enforces a published subset at exposure and every dispatch on %s without discovering unselected MCP servers',
  async (provider) => {
    const { bindAgentToolSelection } = await import('../agent-tool-selection.js');
    const registry = new SessionRegistry();
    registry.register('selected-client', {
      sessionId: `selected-${provider}`,
      cwd: '/tmp',
      mode: 'agent',
      abortController: new AbortController(),
      sessionAllowList: new Set(),
    } as never);
    const session = registry.get('selected-client')!;
    bindAgentToolSelection(session, {
      tools: [
        { id: 'mitzo:GetConnectionGuide', version: 1 },
        { id: 'mitzo:Read', version: 1 },
      ],
    } as never);
    const input = new AsyncQueue<{ message: { content: string } }>();
    const chat = await openResponsesChat({
      conversationId: `selected-${provider}`,
      binding: {
        accountId: 'work',
        accountLabel: 'Work',
        provider,
        model: 'luna-fixture',
        profileRevision: 'r1',
      },
      apiKey: provider === 'openai' ? 'fake-key' : undefined,
      session,
      registry,
      input,
      systemPrompt: 'test',
      env: {},
      mcpServers: { private: { command: 'must-never-launch', args: [] } },
      store: {} as never,
    });
    try {
      const { connectCodexMcpTools } = await import('../codex-mcp-tools.js');
      expect(connectCodexMcpTools).toHaveBeenLastCalledWith({}, expect.any(Object));
      const opts = calls.options.at(-1)! as {
        tools: { name: string }[];
        executeTool(
          block: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
          signal: AbortSignal,
        ): Promise<{ content: string; is_error: boolean }>;
      };
      expect(opts.tools.map((tool) => tool.name).sort()).toEqual([
        'AskUserQuestion',
        'GetConnectionGuide',
        'Read',
      ]);
      for (const name of [
        'ConnectionRequest',
        'RequestGithubPublish',
        'mitzo_mcp_forged',
        'mcp__mitzo-connections__ConnectionRequest',
        'ExecuteProviderCapability',
        'Bash',
      ]) {
        const result = await opts.executeTool(
          { type: 'tool_use', id: `call-${name}`, name, input: {} },
          session.abortController.signal,
        );
        expect(result).toMatchObject({
          is_error: true,
          content: expect.stringMatching(/not selected/i),
        });
      }
      expect(
        await opts.executeTool(
          { type: 'tool_use', id: 'selected-guide', name: 'GetConnectionGuide', input: {} },
          session.abortController.signal,
        ),
      ).toMatchObject({ is_error: false });
      session.activeSkillPolicy = new Set(['Read']);
      expect(
        await opts.executeTool(
          { type: 'tool_use', id: 'revoked-guide', name: 'GetConnectionGuide', input: {} },
          session.abortController.signal,
        ),
      ).toMatchObject({ is_error: true });
    } finally {
      chat.close();
      registry.dispose();
    }
  },
);

it('retains a published tool selection through admitted metadata and cold restart while new profiles affect only new chats', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { AgentLibraryStore } = await import('../agent-library-store.js');
  const { NativeResponsesStore } = await import('../native-responses-store.js');
  const root = mkdtempSync(join(tmpdir(), 'mitzo-tool-acceptance-'));
  let library = new AgentLibraryStore(join(root, 'library.db'));
  let events = new EventStore(join(root, 'events.db'));
  let native = new NativeResponsesStore(join(root, 'native.db'));
  const binding = {
    accountId: 'work',
    accountLabel: 'Work',
    provider: 'openai' as const,
    model: 'luna-fixture',
    profileRevision: 'r1',
  };
  const registry = new SessionRegistry();
  const definition = {
    name: 'Limited',
    role: 'agent',
    instructions: 'Inspect only.',
    expectedOutput: 'Facts',
    acceptanceCriteria: ['Evidence'],
    modelPolicyRole: 'agent',
    tools: [
      { id: 'mitzo:GetConnectionGuide', version: 1 },
      { id: 'mitzo:Read', version: 1 },
    ],
  };
  const open = async (id: string, resume = false) => {
    registry.register(id, {
      sessionId: id,
      cwd: root,
      mode: 'ask',
      abortController: new AbortController(),
      sessionAllowList: new Set(),
    } as never);
    return openResponsesChat({
      conversationId: id,
      resume,
      binding,
      apiKey: 'fake-key',
      session: registry.get(id)!,
      registry,
      input: new AsyncQueue<{ message: { content: string } }>(),
      eventStore: events,
      store: native,
      systemPrompt: 'fixture',
      env: {},
      mcpServers: {},
    });
  };
  try {
    const draft = library.saveDraft('user', {
      profileId: 'limited',
      expectedVersion: 0,
      expectedRevision: 0,
      definition,
      idempotencyKey: 'draft',
    });
    const first = library.publish('user', {
      profileId: 'limited',
      expectedVersion: draft.version,
      idempotencyKey: 'publish',
    });
    events.upsertSession({ sessionId: 'original', agentProfile: first });
    const chat = await open('original');
    const before = calls.options.at(-1)!.tools;
    const next = library.saveDraft('user', {
      profileId: 'limited',
      expectedVersion: 0,
      expectedRevision: first.revision,
      definition: { ...definition, tools: [] },
      idempotencyKey: 'empty-draft',
    });
    const second = library.publish('user', {
      profileId: 'limited',
      expectedVersion: next.version,
      idempotencyKey: 'empty-publish',
    });
    expect(calls.options.at(-1)!.tools).toEqual(before);
    expect(events.getSession('original')?.agentProfile).toEqual(first);
    chat.close();
    registry.dispose();
    library.close();
    events.close();
    native.close();
    library = new AgentLibraryStore(join(root, 'library.db'));
    events = new EventStore(join(root, 'events.db'));
    native = new NativeResponsesStore(join(root, 'native.db'));
    const cold = await open('original', true);
    expect(calls.options.at(-1)!.tools).toEqual(before);
    cold.close();
    expect(library.version('user', 'limited', 1)).toEqual(first);
    events.upsertSession({ sessionId: 'new', agentProfile: second });
    const fresh = await open('new');
    expect((calls.options.at(-1)!.tools as { name: string }[]).map((tool) => tool.name)).toEqual([
      'AskUserQuestion',
    ]);
    fresh.close();
  } finally {
    registry.dispose();
    library.close();
    events.close();
    native.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it.each([
  { provider: 'openai' as const, tools: [] },
  { provider: 'openai' as const, tools: [{ id: 'mitzo:Read', version: 1 }] },
  { provider: 'google-vertex' as const, tools: [] },
  { provider: 'google-vertex' as const, tools: [{ id: 'mitzo:Read', version: 1 }] },
])(
  'keeps the retained published selection after edits and cold API resume: %j',
  async ({ provider, tools }) => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-selected-api-'));
    const database = join(root, 'events.db');
    const privateDatabase = join(root, 'private.db');
    let events = new EventStore(database);
    let library = new AgentLibraryStore(database);
    let store = new NativeResponsesStore(privateDatabase);
    const binding = {
      accountId: 'work',
      accountLabel: 'Work',
      provider,
      model: 'offline-fixture',
      profileRevision: 'r1',
    };
    const definition = {
      name: 'Limited',
      role: 'agent' as const,
      instructions: 'Inspect.',
      expectedOutput: 'Facts',
      acceptanceCriteria: ['Evidence'],
      modelPolicyRole: 'agent' as const,
      tools,
    };
    const registry = new SessionRegistry();
    const expectedNames = ['AskUserQuestion', ...(tools.length ? ['Read'] : [])];
    try {
      const draft = library.saveDraft('user', {
        profileId: 'limited',
        expectedVersion: 0,
        expectedRevision: 0,
        idempotencyKey: 'first-draft',
        definition,
      });
      const published = library.publish('user', {
        profileId: 'limited',
        expectedVersion: draft.version,
        idempotencyKey: 'first-publish',
      });
      events.upsertSession({ sessionId: 'selected-app', agentProfile: published });
      for (const resume of [false, true]) {
        registry.register('selection-client', {
          sessionId: 'selected-app',
          cwd: '/tmp',
          mode: 'agent',
          abortController: new AbortController(),
          sessionAllowList: new Set(),
        } as never);
        const session = registry.get('selection-client')!;
        const input = new AsyncQueue<{ message: { content: string } }>();
        input.close();
        const chat = await openResponsesChat({
          conversationId: 'selected-app',
          binding,
          session,
          registry,
          input,
          systemPrompt: '',
          env: {},
          mcpServers: { hidden: { command: 'must-never-launch', args: [] } },
          eventStore: events,
          store,
          resume,
        });
        try {
          const options = calls.options.at(-1)! as {
            tools: { name: string }[];
            executeTool(
              block: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
              signal: AbortSignal,
            ): Promise<{ is_error: boolean; content: string }>;
          };
          expect(options.tools.map((tool) => tool.name).sort()).toEqual(expectedNames);
          for (const name of [
            'Bash',
            'ConnectionRequest',
            'mcp__mitzo-connections__ConnectionRequest',
            'ExecuteProviderCapability',
            'mitzo_mcp_forged',
            ...(!tools.length ? ['Read', 'mcp__mitzo-connections__Read'] : []),
          ]) {
            await expect(
              options.executeTool(
                { type: 'tool_use', id: `deny-${name}`, name, input: {} },
                session.abortController.signal,
              ),
            ).resolves.toMatchObject({
              is_error: true,
              content: expect.stringMatching(/not selected/i),
            });
          }
        } finally {
          chat.close();
          session.abortController.abort();
        }
        if (!resume) {
          const next = library.saveDraft('user', {
            profileId: 'limited',
            expectedVersion: 0,
            expectedRevision: 1,
            idempotencyKey: 'next-draft',
            definition: {
              ...definition,
              tools: tools.length ? [] : [{ id: 'mitzo:Read', version: 1 }],
            },
          });
          library.publish('user', {
            profileId: 'limited',
            expectedVersion: next.version,
            idempotencyKey: 'next-publish',
          });
          store.close();
          events.close();
          library.close();
          store = new NativeResponsesStore(privateDatabase);
          events = new EventStore(database);
          library = new AgentLibraryStore(database);
          expect(events.getSession('selected-app')?.agentProfile).toEqual(published);
        }
      }
    } finally {
      registry.dispose();
      library.close();
      events.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each(['openai', 'google-vertex'] as const)(
  'admits published API tools with exact dispatch and cold resume on %s',
  async (provider) => {
    const { ApiToolCatalog } = await import('../api-tool-catalog.js');
    const { randomUUID } = await import('node:crypto');
    const root = mkdtempSync(join(tmpdir(), 'mitzo-api-template-'));
    let catalog = new ApiToolCatalog(join(root, 'api.db'));
    let connections = new CredentialConnectionStore(join(root, 'connections.db'));
    let events = new EventStore(join(root, 'events.db'));
    let library = new AgentLibraryStore(join(root, 'events.db'));
    let privateStore = new NativeResponsesStore(join(root, 'private.db'));
    const send = vi.fn<ConnectionSender>(async () => ({
      status: 200,
      body: '{"entity_id":"sensor.office","state":"21","last_changed":"2026-10-17T00:00:00Z"}',
    }));
    const vault = {
      save: vi.fn(async () => ({ service: 'fixture', account: 'fixture' })),
      link: vi.fn(),
      read: vi.fn(async () => 'fake-secret'),
      remove: vi.fn(),
    };
    let service = new CredentialConnections(connections, vault, send);
    const registry = new SessionRegistry();
    const runtime = vi
      .spyOn(credentialRuntime, 'getCredentialConnectionsRuntime')
      .mockImplementation(() => service);
    try {
      const c = await service.create(
        {
          label: 'Fixture',
          serviceTemplate: 'home-assistant',
          endpoint: 'https://ha.example.com',
          auth: { kind: 'bearer' },
          methods: ['GET'],
          paths: ['/api/'],
        },
        { secret: 'fixture' },
      );
      const draft = catalog.save(
        {
          id: randomUUID(),
          expectedVersion: 0,
          configuration: {
            template: 'home-assistant.state@1',
            label: 'Office',
            connectionId: c.id,
            entityId: 'sensor.office',
          },
        },
        service,
      );
      await catalog.verify(draft.id, 1, {
        service,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      const entry = catalog.publish(draft.id, 1, service);
      const definition = {
        name: 'Reader',
        role: 'agent' as const,
        instructions: 'Read.',
        expectedOutput: 'State',
        acceptanceCriteria: ['Evidence'],
        modelPolicyRole: 'agent' as const,
        tools: [catalog.reference(entry), { id: 'mitzo:RequestConnectionAccess', version: 1 }],
      };
      const saved = library.saveDraft('user', {
        profileId: 'api-reader',
        expectedVersion: 0,
        expectedRevision: 0,
        idempotencyKey: 'save',
        definition,
      });
      const published = library.publish('user', {
        profileId: 'api-reader',
        expectedVersion: saved.version,
        idempotencyKey: 'publish',
      });
      const exported = library.version('user', 'api-reader', 1);
      expect(JSON.stringify(exported)).not.toMatch(
        /sensor.office|ha.example.com|connectionId|fake-secret/,
      );
      const imported = library.importDraft('user', {
        profileId: 'imported-api-reader',
        artifact: exported,
        idempotencyKey: 'import-api',
      });
      expect(imported.definition.tools).toEqual(definition.tools);
      const foreignCatalog = new ApiToolCatalog(':memory:');
      try {
        expect(() => foreignCatalog.resolve(imported.definition.tools![0], service)).toThrow(
          /unresolved/,
        );
        expect(service.sessions(c.id)).toEqual([]);
      } finally {
        foreignCatalog.close();
      }
      events.upsertSession({ sessionId: 'api-chat', agentProfile: published });
      const wire = catalog.resolve(entry, service).definition.name;
      for (const attempt of [0, 1, 2]) {
        const resume = attempt > 0;
        registry.register('api-client', {
          sessionId: 'api-chat',
          cwd: root,
          mode: 'agent',
          abortController: new AbortController(),
          sessionAllowList: new Set(),
        } as never);
        const session = registry.get('api-client')!;
        if (attempt < 2) service.grant('api-chat', c.id, c.revision);
        const input = new AsyncQueue<{ message: { content: string } }>();
        input.close();
        const openOptions: Parameters<typeof openResponsesChat>[0] = {
          conversationId: 'api-chat',
          binding: {
            accountId: 'fixture',
            accountLabel: 'Fixture',
            provider,
            model: 'offline-fixture',
            profileRevision: 'r1',
          },
          session,
          registry,
          input,
          systemPrompt: '',
          env: {},
          mcpServers: {},
          eventStore: events,
          store: privateStore,
          resume,
          apiTools: { catalog },
        };
        if (attempt === 2) {
          send.mockClear();
          await expect(openResponsesChat(openOptions)).rejects.toThrow(/API tool/);
          expect(send).not.toHaveBeenCalled();
          continue;
        }
        const chat = await openResponsesChat(openOptions);
        const options = calls.options.at(-1)! as {
          tools: { name: string }[];
          executeTool(
            block: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
            signal: AbortSignal,
          ): Promise<{ is_error: boolean; content: string }>;
        };
        expect(options.tools.map((t) => t.name).sort()).toEqual(
          ['AskUserQuestion', 'RequestConnectionAccess', wire].sort(),
        );
        send.mockClear();
        for (const name of [
          'ConnectionRequest',
          'mcp__mitzo-connections__ConnectionRequest',
          'api_forged',
          entry.id,
          'ExecuteProviderCapability',
        ])
          expect(
            (
              await options.executeTool(
                { type: 'tool_use', id: 'deny', name, input: {} },
                session.abortController.signal,
              )
            ).is_error,
          ).toBe(true);
        expect(send).not.toHaveBeenCalled();
        expect(
          (
            await options.executeTool(
              { type: 'tool_use', id: 'read', name: wire, input: {} },
              session.abortController.signal,
            )
          ).is_error,
        ).toBe(false);
        expect(send).toHaveBeenCalledOnce();
        if (resume) {
          const changed = catalog.save(
            {
              id: draft.id,
              expectedVersion: 1,
              configuration: { ...draft.configuration, entityId: 'sensor.other' },
            },
            service,
          );
          send.mockResolvedValueOnce({
            status: 200,
            body: '{"entity_id":"sensor.other","state":"22","last_changed":"2026-10-17T00:00:00Z"}',
          });
          await catalog.verify(draft.id, changed.version, {
            service,
            signal: new AbortController().signal,
            assertCurrent: () => {},
          });
          const replacement = catalog.publish(draft.id, changed.version, service);
          expect(replacement.version).toBe(2);
          send.mockClear();
          expect(
            (
              await options.executeTool(
                { type: 'tool_use', id: 'stale', name: wire, input: {} },
                session.abortController.signal,
              )
            ).is_error,
          ).toBe(true);
          expect(send).not.toHaveBeenCalled();
        }
        chat.close();
        session.abortController.abort();
        if (!resume) {
          const next = library.saveDraft('user', {
            profileId: 'api-reader',
            expectedVersion: 0,
            expectedRevision: 1,
            idempotencyKey: 'next',
            definition: { ...definition, tools: [] },
          });
          library.publish('user', {
            profileId: 'api-reader',
            expectedVersion: next.version,
            idempotencyKey: 'next-publish',
          });
        }
        if (attempt < 2) {
          catalog.close();
          connections.close();
          privateStore.close();
          library.close();
          events.close();
          catalog = new ApiToolCatalog(join(root, 'api.db'));
          connections = new CredentialConnectionStore(join(root, 'connections.db'));
          service = new CredentialConnections(connections, vault, send);
          privateStore = new NativeResponsesStore(join(root, 'private.db'));
          events = new EventStore(join(root, 'events.db'));
          library = new AgentLibraryStore(join(root, 'events.db'));
        }
      }
    } finally {
      runtime.mockRestore();
      registry.dispose();
      catalog.close();
      connections.close();
      privateStore.close();
      library.close();
      events.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each([true, false])(
  'advertises task tools only for qualified Responses runtime owners (qualified=%s)',
  async (qualified) => {
    const { bindAgentLibraryTransport } = await import('../agent-library-transport.js');
    const { SymposiumProfileProposalStore } = await import('../symposium-profile-proposals.js');
    const { default: Database } = await import('better-sqlite3');
    const root = mkdtempSync(join(tmpdir(), 'task-api-route-'));
    vi.stubEnv('REPO_PATH', root);
    const registry = new SessionRegistry();
    registry.register('task-api-client', {
      transport: { send() {}, isOpen: () => true },
      abortController: new AbortController(),
      mode: 'agent',
      sessionId: 'task-api-chat',
      cwd: root,
      sessionAllowList: new Set(),
    });
    const release = bindAgentLibraryTransport('task-api-client', {
      id: `task-api-login-${qualified}`,
      expiresAt: Date.now() + 60000,
    });
    const input = new AsyncQueue<{ message: { content: string }; mitzoMessageId: string }>();
    if (qualified)
      input.push({
        message: { content: 'task-route-proposal' },
        mitzoMessageId: 'task-api-command',
      });
    input.close();
    const authority = {
      assertPrepare: vi.fn(),
      assertStart: vi.fn(),
      assertEffect: vi.fn(async () => {}),
    };
    calls.taskInput = {
      taskId: 'daily',
      expectedRevision: 0,
      definition: {
        name: 'Daily',
        objective: '',
        profile: { profileId: 'trace', revision: 3, contentHash: 'a'.repeat(64) },
        execution: null,
        workspace: null,
        schedule: { cron: '0 9 * * *', timezone: 'Europe/Dublin', state: 'paused' },
        notificationPolicy: 'results',
        outputPolicy: 'session',
      },
    };
    calls.taskResults = [];
    let chat: Awaited<ReturnType<typeof openResponsesChat>> | undefined;
    try {
      chat = await openResponsesChat({
        conversationId: 'task-api-chat',
        binding: {
          accountId: 'fixture',
          accountLabel: 'Offline fixture',
          provider: 'openai',
          model: 'offline-model',
          profileRevision: 'fixture-r1',
        },
        getApiKey: async () => 'offline-fixture',
        session: registry.get('task-api-client')!,
        registry,
        input,
        systemPrompt: '',
        env: { PATH: '/usr/bin:/bin' },
        mcpServers: {},
        store: {} as never,
        ...(qualified ? { commandAuthority: authority, assertStartupCurrent: vi.fn() } : {}),
      });
      const toolNames = (calls.options.at(-1)!.tools as Array<{ name: string }>).map(
        ({ name }) => name,
      );
      for (const name of ['AgentReadTasks', 'AgentProposeTask'])
        expect(toolNames.includes(name)).toBe(qualified);
      for await (const event of chat) expect(event).toBeDefined();
      if (qualified) {
        expect(calls.taskResults[0]).toMatchObject({ is_error: false });
        expect(calls.taskResults[1]).toEqual(calls.taskResults[0]);
        expect(calls.taskResults[2]).toMatchObject({
          is_error: true,
          content: expect.stringMatching(/conflict/i),
        });
        const receipt = JSON.parse(calls.taskResults[0].content);
        expect(receipt).toMatchObject({
          status: 'awaiting_user_review',
          taskId: 'daily',
          expectedRevision: 0,
        });
        expect(authority.assertEffect).toHaveBeenCalledWith('task-api-command');
        expect(authority.assertStart).toHaveBeenCalledWith('task-api-command');
        const proposals = new SymposiumProfileProposalStore(join(root, '.mitzo', 'events.db'));
        try {
          expect(proposals.listTaskProposals('user', 'task-api-chat')).toHaveLength(1);
        } finally {
          proposals.close();
        }
        const db = new Database(join(root, '.mitzo', 'events.db'), { readonly: true });
        try {
          expect(
            db
              .prepare("SELECT idempotency_key FROM symposium_profile_proposals WHERE kind='task'")
              .get(),
          ).toEqual({
            idempotency_key: createHash('sha256')
              .update(
                JSON.stringify(['task', 'task-api-chat', 'task-api-command', 'task-provider-call']),
              )
              .digest('hex'),
          });
          expect(
            db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'agent_task_%'").all(),
          ).toEqual([]);
        } finally {
          db.close();
        }
      }
    } finally {
      chat?.close();
      release();
      registry.dispose();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

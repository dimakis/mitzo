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

async function freshChat() {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-initial-admission-'));
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
  return { chat, root };
}

it('acknowledges initial admission before provider readiness while completion remains held', async () => {
  const { chat, root } = await freshChat();
  const sessionId = '5f68a371-73d1-4994-a512-b71d4bc44c65';
  let releaseFirst!: () => void;
  let releaseResult!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const result = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  let completed = false;

  vi.mocked(query).mockImplementation(
    () =>
      (async function* () {
        await first;
        yield { type: 'stream_event', event: { type: 'message_start', message: { id: 'first' } } };
        await result;
        yield {
          type: 'result',
          session_id: sessionId,
          subtype: 'success',
          usage: {},
          total_cost_usd: 0,
          num_turns: 1,
        };
      })() as ReturnType<typeof query>,
  );

  try {
    const launch = chat.launchChat(
      { send: () => {}, isOpen: () => true },
      'admit-driver',
      'hello',
      {
        cwd: root,
        isolation: false,
        initialSessionId: sessionId,
        clientMsgId: 'initial-message',
        requestFingerprint: 'initial-fingerprint',
      },
    );
    void launch.completion.then(() => {
      completed = true;
    });

    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    const runtime = chat.registry.findBySessionId(sessionId);
    const running = chat.eventStore.getSession(sessionId);
    expect(runtime?.session.currentExecution).toMatchObject({ sessionId, generation: 1 });
    expect(running).toMatchObject({ sessionId, executionPhase: 'RUNNING', executionGeneration: 1 });
    await expect(launch.accepted).resolves.toMatchObject({
      sessionId,
      token: { sessionId, generation: 1 },
    });
    expect(completed).toBe(false);

    releaseFirst();
    expect(completed).toBe(false);

    releaseResult();
    await launch.completion;
    expect(chat.eventStore.getSession(sessionId)).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'completed',
      executionGeneration: 1,
    });
    expect(
      chat.eventStore
        .getSessionEvents(sessionId)
        .filter((event) => event.payload.phase === 'TERMINAL'),
    ).toHaveLength(1);
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('terminalizes a pre-ready provider failure without leaking raw provider diagnostics', async () => {
  const { chat, root } = await freshChat();
  const sessionId = '7a68a371-73d1-4994-a512-b71d4bc44c65';
  const sent: Record<string, unknown>[] = [];
  const raw = 'secret-token /private/provider/path https://provider.invalid prompt=hello';
  vi.mocked(query).mockImplementation(
    () =>
      (async function* () {
        if (Date.now() < 0) yield {};
        throw new Error(raw);
      })() as ReturnType<typeof query>,
  );

  try {
    const launch = chat.launchChat(
      { send: (event) => sent.push(event), isOpen: () => true },
      'failed-driver',
      'hello',
      {
        cwd: root,
        isolation: false,
        initialSessionId: sessionId,
        clientMsgId: 'failed-initial-message',
        requestFingerprint: 'failed-initial-fingerprint',
      },
    );
    await expect(launch.accepted).resolves.toMatchObject({ sessionId, token: { generation: 1 } });
    // Provider failure follows a durable admission; it cannot revoke the receipt.
    void launch.completion.catch(() => undefined);
    await vi.waitFor(() =>
      expect(chat.eventStore.getSession(sessionId)?.executionTerminalReason).toBe('startup_failed'),
    );

    expect(chat.eventStore.getSession(sessionId)).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'startup_failed',
      isActive: false,
    });
    expect(chat.registry.findBySessionId(sessionId)).toBeNull();
    const persisted = JSON.stringify({
      receipt: chat.eventStore.getSendCommand('failed-initial-message'),
      events: chat.eventStore.getSessionEvents(sessionId),
      sent,
    });
    expect(persisted).not.toContain('secret-token');
    expect(persisted).not.toContain('/private/provider/path');
    expect(persisted).not.toContain('provider.invalid');
    expect(persisted).not.toContain('prompt=hello');
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('fails queued FIFO work instead of admitting it while a provider stream tears down', async () => {
  const { chat, root } = await freshChat();
  const sessionId = '7b68a371-73d1-4994-a512-b71d4bc44c65';
  let providerReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    providerReady = resolve;
  });
  let failStream!: () => void;
  const streamFailure = new Promise<void>((resolve) => {
    failStream = resolve;
  });
  vi.mocked(query).mockImplementation(
    () =>
      (async function* () {
        yield {
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'provider-ready-first-event' } },
        };
        await streamFailure;
        throw new Error('provider stream failed after admission');
      })() as ReturnType<typeof query>,
  );

  try {
    const launch = chat.launchChat(
      { send: () => {}, isOpen: () => true },
      'provider-failure-fifo-driver',
      'initial request',
      {
        cwd: root,
        isolation: false,
        initialSessionId: sessionId,
        clientMsgId: 'provider-failure-initial',
        requestFingerprint: 'provider-failure-initial-fingerprint',
        onProviderReady: () => providerReady(),
      },
    );
    await expect(launch.accepted).resolves.toMatchObject({ token: { generation: 1 } });
    await ready;

    // HTTP/REST admission creates this durable receipt before the bounded
    // FIFO closure. Teardown must turn it into the one safe terminal event.
    chat.eventStore.insertSendCommand(
      'provider-failure-queued',
      sessionId,
      {},
      'provider-failure-queued-fingerprint',
    );
    const queued = chat.sendToChat(
      'provider-failure-fifo-driver',
      'must not inherit a dying provider',
      undefined,
      undefined,
      'provider-failure-queued',
    );
    expect(chat.registry.findBySessionId(sessionId)?.session.pendingExecutions).toHaveLength(1);

    // The query loop invokes its provider-failure callback before its finally
    // block removes the runtime. That callback must not pump this FIFO head.
    failStream();
    await expect(queued).resolves.toBe(false);
    await expect(launch.completion).resolves.toBeUndefined();

    const events = chat.eventStore.getSessionEvents(sessionId);
    expect(
      events.filter(
        (event) => event.type === 'execution_state_changed' && event.payload.phase === 'RUNNING',
      ),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === 'user_message')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'queued_send_failed')).toHaveLength(1);
    expect(chat.eventStore.getSession(sessionId)).toMatchObject({
      executionPhase: 'TERMINAL',
      executionGeneration: 1,
      executionTerminalReason: 'failed',
    });
    expect(chat.registry.findBySessionId(sessionId)).toBeNull();
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('fails queued FIFO work instead of admitting it after an explicit failed result', async () => {
  const { chat, root } = await freshChat();
  const sessionId = '7c68a371-73d1-4994-a512-b71d4bc44c65';
  let releaseFailedResult!: () => void;
  const failedResult = new Promise<void>((resolve) => {
    releaseFailedResult = resolve;
  });
  vi.mocked(query).mockImplementation(
    () =>
      (async function* () {
        yield { type: 'stream_event', event: { type: 'message_start', message: { id: 'first' } } };
        await failedResult;
        yield {
          type: 'result',
          session_id: sessionId,
          subtype: 'error_max_turns',
          usage: {},
          total_cost_usd: 0,
          num_turns: 1,
        };
      })() as ReturnType<typeof query>,
  );

  try {
    const launch = chat.launchChat(
      { send: () => {}, isOpen: () => true },
      'failed-result-fifo-driver',
      'initial request',
      {
        cwd: root,
        isolation: false,
        initialSessionId: sessionId,
        clientMsgId: 'failed-result-initial',
        requestFingerprint: 'failed-result-initial-fingerprint',
      },
    );
    await expect(launch.accepted).resolves.toMatchObject({ token: { generation: 1 } });

    chat.eventStore.insertSendCommand(
      'failed-result-queued',
      sessionId,
      {},
      'failed-result-queued-fingerprint',
    );
    const queued = chat.sendToChat(
      'failed-result-fifo-driver',
      'must not inherit a failed provider result',
      undefined,
      undefined,
      'failed-result-queued',
    );
    expect(chat.registry.findBySessionId(sessionId)?.session.pendingExecutions).toHaveLength(1);

    // `result` callbacks happen before query-loop teardown. A failure must
    // terminalize only its own token and leave the queued receipt to teardown.
    releaseFailedResult();
    await expect(queued).resolves.toBe(false);
    await expect(launch.completion).resolves.toBeUndefined();

    const events = chat.eventStore.getSessionEvents(sessionId);
    expect(
      events.filter(
        (event) => event.type === 'execution_state_changed' && event.payload.phase === 'RUNNING',
      ),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === 'user_message')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'queued_send_failed')).toHaveLength(1);
    expect(chat.eventStore.getSession(sessionId)).toMatchObject({
      executionPhase: 'TERMINAL',
      executionGeneration: 1,
      executionTerminalReason: 'failed',
    });
    expect(chat.registry.findBySessionId(sessionId)).toBeNull();
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('stops an admitted pre-ready execution before removing its runtime', async () => {
  const { chat, root } = await freshChat();
  const sessionId = '8a68a371-73d1-4994-a512-b71d4bc44c65';
  vi.mocked(query).mockImplementation(
    (args) =>
      (async function* () {
        await new Promise<void>((resolve) => {
          args.options?.abortController?.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        if (Date.now() < 0) yield {};
      })() as ReturnType<typeof query>,
  );

  try {
    const launch = chat.launchChat(
      { send: () => {}, isOpen: () => true },
      'stopped-driver',
      'hello',
      {
        cwd: root,
        isolation: false,
        initialSessionId: sessionId,
        clientMsgId: 'stopped-initial-message',
        requestFingerprint: 'stopped-initial-fingerprint',
      },
    );
    await expect(launch.accepted).resolves.toMatchObject({ sessionId, token: { generation: 1 } });
    void launch.completion.catch(() => undefined);
    await chat.stopChat('stopped-driver');

    expect(chat.eventStore.getSession(sessionId)).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'stopped',
    });
    expect(chat.registry.findBySessionId(sessionId)).toBeNull();
    expect(
      chat.eventStore
        .getSessionEvents(sessionId)
        .filter((event) => event.payload.phase === 'TERMINAL'),
    ).toHaveLength(1);
    await expect(launch.completion).resolves.toBeUndefined();
    expect(
      chat.eventStore
        .getSessionEvents(sessionId)
        .findLast((event) => event.type === 'session_state_changed')?.payload,
    ).toMatchObject({ internalState: 'ENDED', reason: 'stopped' });
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not poison a live execution with a stopped marker when durable stop fails', async () => {
  const { chat, root } = await freshChat();
  const sessionId = '9a68a371-73d1-4994-a512-b71d4bc44c65';
  vi.mocked(query).mockImplementation(
    (args) =>
      (async function* () {
        await new Promise<void>((resolve) => {
          args.options?.abortController?.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        if (Date.now() < 0) yield {};
      })() as ReturnType<typeof query>,
  );

  try {
    const launch = chat.launchChat(
      { send: () => {}, isOpen: () => true },
      'stop-transition-failure-driver',
      'hello',
      {
        cwd: root,
        isolation: false,
        initialSessionId: sessionId,
        clientMsgId: 'stop-transition-failure-message',
        requestFingerprint: 'stop-transition-failure-fingerprint',
      },
    );
    const admission = await launch.accepted;
    const transition = vi.spyOn(chat.eventStore, 'transitionExecution').mockImplementation(() => {
      throw new Error('durable transition unavailable');
    });

    await expect(chat.stopChat('stop-transition-failure-driver')).rejects.toThrow(
      'durable transition unavailable',
    );
    const runtime = chat.registry.findBySessionId(sessionId)?.session;
    expect(runtime?.currentExecution).toEqual(admission.token);
    expect(runtime?.stoppedExecution).toBeUndefined();
    expect(chat.eventStore.getSession(sessionId)?.executionPhase).toBe('RUNNING');

    transition.mockRestore();
    chat.registry.abort('stop-transition-failure-driver');
    await expect(launch.completion).rejects.toThrow('Chat provider did not become ready');
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not mark or clean up a live runtime when its stop token is stale', async () => {
  const { chat, root } = await freshChat();
  const sessionId = 'aa68a371-73d1-4994-a512-b71d4bc44c65';
  vi.mocked(query).mockImplementation(
    (args) =>
      (async function* () {
        await new Promise<void>((resolve) => {
          args.options?.abortController?.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        if (Date.now() < 0) yield {};
      })() as ReturnType<typeof query>,
  );

  try {
    const launch = chat.launchChat(
      { send: () => {}, isOpen: () => true },
      'stop-stale-driver',
      'hello',
      {
        cwd: root,
        isolation: false,
        initialSessionId: sessionId,
        clientMsgId: 'stop-stale-message',
        requestFingerprint: 'stop-stale-fingerprint',
      },
    );
    const admission = await launch.accepted;
    const transition = vi.spyOn(chat.eventStore, 'transitionExecution').mockReturnValue({
      applied: false,
      status: 'stale',
      token: admission.token,
    });

    await expect(chat.stopChat('stop-stale-driver')).resolves.toBeUndefined();
    const runtime = chat.registry.findBySessionId(sessionId)?.session;
    expect(runtime?.currentExecution).toEqual(admission.token);
    expect(runtime?.stoppedExecution).toBeUndefined();

    transition.mockRestore();
    chat.registry.abort('stop-stale-driver');
    await expect(launch.completion).rejects.toThrow('Chat provider did not become ready');
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

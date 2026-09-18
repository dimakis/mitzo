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

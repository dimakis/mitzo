import { expect, it, vi } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';
import { EventStore } from '../event-store.js';
import { OrdinaryLocalVertexCommandOwner } from '../ordinary-local-vertex-command-owner.js';
import { OrdinarySdkTurnEvidence } from '../ordinary-sdk-turn-evidence.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
} from '../ordinary-local-vertex-sdk-query.js';
import { runQueryLoop } from '../query-loop.js';
import { replayEventsToMessages } from '../conversation-transcript.js';
import type { SessionRegistry } from '../session-registry.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  getSessionInfo: vi.fn(async () => ({ sessionId: 'session', cwd: '/task' })),
  getSessionMessages: vi.fn(async () => [{ uuid: 'be1f9b3c-9b56-46ac-b77d-d26a108d075a' }]),
}));

it.each(['session_writes_lost', 'mirror_error'])(
  'delivers %s through the SDK, real command successor owner and query consumer',
  async (subtype) => {
    const streams = [
      new AsyncQueue<Record<string, unknown>>(),
      new AsyncQueue<Record<string, unknown>>(),
    ];
    const prompts: AsyncIterator<SDKUserMessage>[] = [];
    const closes: ReturnType<typeof vi.fn>[] = [];
    vi.mocked(query).mockImplementation((request) => {
      const stream = streams[prompts.length];
      prompts.push((request.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]());
      const close = vi.fn();
      closes.push(close);
      return { close, [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator]() } as never;
    });
    const controller = new AbortController();
    const sdk = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
      options: {
        sessionId: 'session',
        ...(subtype === 'mirror_error'
          ? { sessionStore: { append: async () => {}, load: async () => null } as never }
          : {}),
      },
      input: new AsyncQueue(),
      controller,
      lifetime: new SdkHookLifetime(),
      sdkSessionId: 'session',
      cwd: '/task',
      authorize: async () => {},
      authorizeSync: () => {},
      adapt: (native) => native as never,
      settings: (selection) => ({ model: selection.model }),
      inputChanged: () => {},
      onUnsent: (_input, cause) => {
        throw cause;
      },
    });
    const store = new EventStore(':memory:');
    const account = {
      accountId: 'vertex',
      provider: 'anthropic-vertex' as const,
      profileRevision: 'profile',
    };
    const binding = {
      version: 2 as const,
      account,
      harness: { implementation: 'claude-sdk' as const },
      execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'target' },
    };
    const meta = {
      sessionId: 'session',
      repositoryWorkspaceId: 'workspace',
      cwd: '/task',
      accountBinding: { ...account, accountLabel: 'Vertex', model: 'first' },
    };
    const command = (id: string) => ({
      clientMsgId: id,
      requestFingerprint: `fingerprint-${id}`,
      payload: { text: id },
      selection: {
        version: 1 as const,
        agent: { profileId: 'published', revision: 1 },
        context: { source: 'none' as const, revision: null },
        permission: { mode: 'ask' as const, revision: 0 },
        model: id,
        thinking: null,
      },
    });
    store.admitOrdinaryLocalVertexCommand(meta, binding, command('first'));
    const owner = new OrdinaryLocalVertexCommandOwner({
      store,
      sessionId: 'session',
      assertCurrent: async () => {},
      assertCurrentSync: () => {},
      ownsClaim: (id) => store.getOrdinaryLocalVertexCommandAdmission(id)?.state === 'consumed',
      turnEvidence: new OrdinarySdkTurnEvidence(store, 'session', 'session'),
      query: {
        abort: () => controller.abort(),
        bindCommandToolAuthority: sdk.bindCommandToolAuthority,
        applySettings: sdk.apply,
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        push: async (id, _admission, payload) => {
          // The real chat echo owner saves public input after guarded FIFO admission.
          store.append('session', 'user_message', {
            v: 2,
            type: 'user_message',
            sessionId: 'session',
            messageId: id,
            text: String(payload.text),
          });
          const inputUuid: SDKUserMessage['uuid'] =
            id === 'first'
              ? 'be1f9b3c-9b56-46ac-b77d-d26a108d075a'
              : '7fbc1b2f-3e1e-43d0-91db-d6f8a7951d09';
          const message = {
            type: 'user' as const,
            session_id: 'session',
            parent_tool_use_id: null,
            uuid: inputUuid,
            message: { role: 'user' as const, content: String(payload.text) },
            mitzoMessageId: id,
          };
          sdk.push(message);
          expect((await prompts.at(-1)!.next()).value).toMatchObject({ uuid: inputUuid });
          streams[prompts.length - 1].push(message);
          if (id === 'second') {
            streams[1].push({ type: 'result', session_id: 'session', is_error: false });
            streams[1].close();
          }
        },
      },
      settings: (selection) => ({ model: selection.model, thinkingTokens: null }),
    });
    const sent: Record<string, unknown>[] = [];
    const transport = {
      send: (event: Record<string, unknown>) => sent.push(event),
      isOpen: () => true,
    };
    const session = {
      transport,
      sessionId: 'session',
      observers: new Set(),
      currentSnapshot: null,
      cumulativeSessionTokens: 0,
      cumulativeCostUsd: 0,
    };
    const registry = {
      get: () => session,
      findBySessionId: () => undefined,
      setSessionId: () => {},
      remove: () => {},
      isAttached: () => true,
      isSuspended: () => false,
      bufferEvent: () => false,
    } as unknown as SessionRegistry;
    try {
      await owner.enqueue('first');
      store.admitOrdinaryLocalVertexContinuation(
        { ...meta, accountBinding: { ...meta.accountBinding, model: 'second' } },
        binding,
        command('second'),
      );
      await owner.enqueue('second');
      streams[0].push({ type: 'result', session_id: 'session', is_error: false });
      streams[0].push({
        type: 'system',
        subtype,
        session_id: 'session',
        uuid: 'f01230f4-aa98-4b55-acd4-f02385e3af04',
        lost: ['transcript'],
        key: { projectKey: 'PRIVATE_PROJECT', sessionId: 'session' },
        error: 'PRIVATE_NATIVE_CAUSE',
      });
      streams[0].push({
        type: 'user',
        session_id: 'session',
        uuid: 'stale-input',
        message: { role: 'user', content: 'stale' },
      });
      streams[0].push({
        type: 'assistant',
        session_id: 'session',
        uuid: 'stale-output',
        message: { content: [{ type: 'text', text: 'STALE_OUTPUT' }] },
      });
      streams[0].push({ type: 'result', session_id: 'session', is_error: false });
      streams[0].close();
      let delivered = 0;
      await runQueryLoop(sdk.query, 'client', registry, controller, store, undefined, {
        onUserInput: (_client, uuid) => owner.inputObserved(uuid),
        onResult: async (_client, result, uuid) =>
          owner.resultObserved(uuid, result.is_error === true, { dispatchSuccessor: false }),
        onResultDelivered: async () => {
          if (++delivered === 1) {
            await owner.dispatchQueued();
            expect(prompts).toHaveLength(2);
            expect(closes[0]).toHaveBeenCalledOnce();
          } else (sdk.query as unknown as { close(): void }).close();
        },
      });
      expect(delivered).toBe(2);
      const notices = sent.filter((event) => event.code === `claude_${subtype}`);
      expect(notices).toHaveLength(1);
      expect(JSON.stringify(sent)).not.toContain('STALE_OUTPUT');
      expect(store.getOrdinaryProviderTurnTerminal('session', 'first')).toBe('completed');
      expect(store.getOrdinaryProviderTurnTerminal('session', 'second')).toBe('completed');
      const restored = replayEventsToMessages(store.getEventsAfter('session', 0));
      expect(JSON.stringify(restored)).toContain('Claude could not save');
      expect(JSON.stringify(restored)).not.toContain('PRIVATE');
    } finally {
      controller.abort();
      streams.forEach((stream) => stream.close());
      store.close();
    }
  },
);

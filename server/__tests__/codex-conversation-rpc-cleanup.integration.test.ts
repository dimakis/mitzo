import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CodexAppServerClient,
  CodexServerRequestResolvedError,
} from '../codex-app-server-client.js';
import { CodexConversation, type CodexConversationOptions } from '../codex-conversation.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import type { FrozenHostCodexBootstrapLease } from '../frozen-host-codex-bootstrap.js';
import type { AccountBinding } from '@mitzo/protocol';
import { OwnedCodexLifecycleBridge } from '../owned-codex-lifecycle-bridge.js';
import { retainCallbackOutcome } from '../turn-callbacks.js';
import { createHash } from 'node:crypto';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const answer = { answers: { question: { answers: ['Continue'] } } };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function question(itemId: string) {
  return {
    threadId: 'thread',
    turnId: 'turn',
    itemId,
    questions: [
      {
        id: 'question',
        header: 'Continue',
        question: 'Continue?',
        isOther: false,
        isSecret: false,
        options: null,
      },
    ],
  };
}

it('never writes a late native grant after the exact provider terminal and keeps settled custody', async () => {
  const f = await fixture();
  const gate = deferred();
  let entered = false;
  f.options.requestNativeApproval = async () => {
    entered = true;
    await gate.promise;
    return { decision: 'accept' };
  };
  f.reply({
    id: 'approval',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread', turnId: 'turn', itemId: 'command' },
  });
  await vi.waitFor(() => expect(entered).toBe(true));
  f.reply({
    method: 'turn/completed',
    params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } },
  });
  gate.resolve();
  await vi.waitFor(() => expect(f.conversation.queue()[0].status).toBe('completed'));
  expect(f.sent.filter((frame) => frame.id === 'approval')).toEqual([]);
  expect(f.lease.close).not.toHaveBeenCalled();
});

it('does not admit a host request whose turn finishes in the same stdio chunk', async () => {
  const f = await fixture();
  const approve = vi.fn(async () => ({ decision: 'accept' }));
  f.options.requestNativeApproval = approve;
  // One write is essential: lifecycle admission normally begins in a microtask.
  f.child.stdout.write(
    [
      {
        id: 'same-chunk',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread', turnId: 'turn', itemId: 'command' },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } },
      },
    ]
      .map((frame) => JSON.stringify(frame) + '\n')
      .join(''),
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(approve).not.toHaveBeenCalled();
  expect(f.sent.filter((frame) => frame.id === 'same-chunk')).toEqual([]);
  expect(f.lease.close).not.toHaveBeenCalled();
});
it('retains an ordinary durable success when exact terminal cancellation interrupts final response authorization', async () => {
  const f = await fixture();
  const gate = deferred();
  let executed = false;
  let finalFence = false;
  const identity = {
    turnId: 'turn',
    toolName: 'Read',
    requestHash: createHash('sha256').update('{}').digest('hex'),
  };
  f.options.executeTool = async () => {
    executed = true;
    return { content: 'original success', isError: false };
  };
  f.setPrepare(async () => {
    if (
      executed &&
      f.store.replayToolResult('conversation', f.getBinding(), 'command', 'call', identity)
    ) {
      finalFence = true;
      await gate.promise;
    }
  });
  f.reply({
    id: 'tool',
    method: 'item/tool/call',
    params: { threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'Read', arguments: {} },
  });
  await vi.waitFor(() => expect(finalFence).toBe(true));
  f.reply({
    method: 'turn/completed',
    params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } },
  });
  gate.resolve();
  await vi.waitFor(() => expect(f.conversation.queue()[0].status).toBe('completed'));
  expect(f.store.commandLifecycle('conversation', f.getBinding(), 'command').effectStatus).toBe(
    'completed',
  );
  expect(f.lease.close).not.toHaveBeenCalled();
  f.noReply('tool');
});

it.each(['known-not-started', 'unknown'] as const)(
  'retains exact %s tool settlement after native terminal cancellation',
  async (outcome) => {
    const f = await fixture();
    const gate = deferred();
    let entered = false;
    f.options.executeTool = async () => {
      entered = true;
      await gate.promise;
      return outcome === 'unknown'
        ? { content: 'unqualified late success', isError: false }
        : retainCallbackOutcome(
            { content: 'approval did not start an action', isError: true },
            'settled',
          );
    };
    f.reply({
      id: 'tool',
      method: 'item/tool/call',
      params: { threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'Read', arguments: {} },
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    f.reply({
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } },
    });
    gate.resolve();
    await vi.waitFor(() => expect(f.conversation.queue()[0].status).toBe('completed'));
    const status = f.store.commandLifecycle('conversation', f.getBinding(), 'command');
    expect(status.effectStatus).toBe(outcome === 'unknown' ? 'unknown' : 'completed');
    if (outcome === 'known-not-started') expect(f.lease.close).not.toHaveBeenCalled();
    expect(f.sent.filter((frame) => frame.id === 'tool')).toEqual([]);
  },
);

/** Real stdio client, owned lease/bridge, conversation and private store. Only
 * the offline protocol peer and application admission/UI boundaries are fixtures. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-rpc-owner-'));
  const store = new CodexConversationStore(join(root, 'private.db'));
  const startup = new AbortController();
  let revoked = false;
  let prepareHook: ((signal: AbortSignal) => Promise<void>) | undefined;
  let questionHook = async (_params: Record<string, unknown>, signal: AbortSignal) => {
    signal.throwIfAborted();
    return answer;
  };
  const assertCurrent = () => {
    if (revoked) throw new Error('Fixture authority revoked');
  };
  const bridge = new OwnedCodexLifecycleBridge(() => lease);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const sent: Record<string, unknown>[] = [];
  const reply = (message: unknown) => child.stdout.write(JSON.stringify(message) + '\n');
  child.stdin.on('data', (chunk) => {
    const message = JSON.parse(chunk.toString()) as Record<string, unknown>;
    sent.push(message);
    if (!message.method || message.id === undefined) return;
    queueMicrotask(() => {
      let result: unknown = {};
      if (message.method === 'account/read')
        result = { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'test' } };
      if (message.method === 'config/read') result = { config: {} };
      if (message.method === 'thread/start')
        result = { thread: { id: 'thread' }, model: 'offline', modelProvider: 'openai' };
      if (message.method === 'turn/start') {
        reply({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } });
        result = { turn: { id: 'turn' } };
      }
      reply({ id: message.id, result });
    });
  });
  const client = new CodexAppServerClient(child, { lifecycle: bridge.lifecycle });
  const lease: FrozenHostCodexBootstrapLease = {
    client,
    profile: {
      accountId: 'personal',
      accountLabel: 'Personal',
      model: 'offline',
      credentialRef: join(root, 'unused-auth'),
      email: 'fixture@example.test',
      planType: 'test',
    },
    binding: {
      accountId: 'personal',
      provider: 'openai-codex',
      profileRevision: 'fixture',
      accountLabel: 'Personal',
      model: 'offline',
    },
    privateHome: root,
    executableSha256: 'a'.repeat(64),
    assertCurrent: async () => assertCurrent(),
    assertCurrentSync: assertCurrent,
    close: vi.fn(() => client.close()),
  };
  const onClosed = vi.fn();
  const requestUserInput = vi.fn((params: Record<string, unknown>, signal: AbortSignal) =>
    questionHook(params, signal),
  );
  const prepareAgentContext = vi.fn(async (signal: AbortSignal) => {
    assertCurrent();
    signal.throwIfAborted();
    await prepareHook?.(signal);
    signal.throwIfAborted();
    assertCurrent();
  });
  const options: CodexConversationOptions = {
    conversationId: 'conversation',
    cwd: root,
    profile: lease.profile,
    store,
    systemPrompt: 'Offline fixture',
    tools: [{ name: 'Read', description: 'Offline tool', input_schema: { type: 'object' } }],
    getMode: () => 'agent',
    startupSignal: startup.signal,
    transportClosure: 'terminal',
    prepareAgentContext,
    requestUserInput,
    createClient: (callbacks) => bridge.attach(callbacks),
    emit: () => {},
    executeTool: async () => {
      throw new Error('No tool may execute in this fixture');
    },
    onClosed,
    onError: vi.fn(),
  };
  const conversation = new CodexConversation(options);
  cleanup.push(() => {
    conversation.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await conversation.initialize();
  await conversation.send({ id: 'command', prompt: 'Offline active turn' });
  const request = (id: string) =>
    reply({ id, method: 'item/tool/requestUserInput', params: question(id) });
  const resolve = (id: string) =>
    reply({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: id } });
  const noReply = (id: string) => expect(sent.filter((frame) => frame.id === id)).toEqual([]);
  const continues = async () => {
    prepareHook = undefined;
    questionHook = async () => answer;
    request('next');
    await vi.waitFor(() => expect(sent).toContainEqual({ id: 'next', result: answer }));
    expect(onClosed).not.toHaveBeenCalled();
    expect(lease.close).not.toHaveBeenCalled();
    noReply('first');
  };
  return {
    bridge,
    getBinding: () => (conversation as unknown as { binding: AccountBinding }).binding,
    reply,
    sent,
    store,
    child,
    client,
    conversation,
    options,
    lease,
    startup,
    onClosed,
    requestUserInput,
    prepareAgentContext,
    request,
    resolve,
    noReply,
    continues,
    revoke: () => {
      revoked = true;
    },
    setPrepare: (hook: typeof prepareHook) => {
      prepareHook = hook;
    },
    setQuestion: (hook: typeof questionHook) => {
      questionHook = hook;
    },
  };
}

it('keeps the real authorized conversation after one upstream-resolved pending question', async () => {
  const f = await fixture();
  f.setQuestion(
    async (_params, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  f.request('first');
  await vi.waitFor(() => expect(f.requestUserInput).toHaveBeenCalledOnce());
  f.resolve('first');
  await vi.waitFor(() => expect(f.prepareAgentContext.mock.calls.length).toBeGreaterThan(3));
  await f.continues();
});

it.each(['initial admission', 'final authorization'] as const)(
  'preserves the owner when resolved arrives during %s, with no operation/reply replay',
  async (phase) => {
    const f = await fixture();
    const gate = deferred();
    let calls = 0;
    let entered = false;
    f.setPrepare(async () => {
      if (++calls === (phase === 'initial admission' ? 1 : 2)) {
        entered = true;
        await gate.promise;
      }
    });
    f.request('first');
    await vi.waitFor(() => expect(entered).toBe(true));
    f.resolve('first');
    gate.resolve();
    await vi.waitFor(() => expect(calls).toBe(phase === 'initial admission' ? 2 : 3));
    expect(f.requestUserInput).toHaveBeenCalledTimes(phase === 'initial admission' ? 0 : 1);
    await f.continues();
  },
);

it.each([
  'authority revoked',
  'host closed',
  'startup aborted',
  'active interrupted',
  'owner callback replaced',
  'request identity changed',
] as const)(
  'closes after resolved cancellation if %s during independent final authorization',
  async (failure) => {
    const f = await fixture();
    const gate = deferred();
    let revalidating = false;
    f.setQuestion(
      async (_params, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    f.request('first');
    await vi.waitFor(() => expect(f.requestUserInput).toHaveBeenCalledOnce());
    f.setPrepare(async () => {
      revalidating = true;
      await gate.promise;
    });
    f.resolve('first');
    await vi.waitFor(() => expect(revalidating).toBe(true));
    if (failure === 'authority revoked') f.revoke();
    if (failure === 'host closed') f.client.close();
    if (failure === 'startup aborted') f.startup.abort(new Error('Owner stopped'));
    if (failure === 'active interrupted') await f.conversation.interrupt();
    if (failure === 'request identity changed')
      f.requestUserInput.mock.calls[0][0].threadId = 'another-thread';
    if (failure === 'owner callback replaced') f.options.prepareAgentContext = async () => {};
    gate.resolve();
    await vi.waitFor(() => expect(f.onClosed).toHaveBeenCalledOnce());
    expect(f.lease.close).toHaveBeenCalledOnce();
    f.noReply('first');
  },
);

it('still closes if authority is revoked during the retry after resolution interrupted final authorization', async () => {
  const f = await fixture();
  const finalGate = deferred();
  const retryGate = deferred();
  let calls = 0;
  f.setPrepare(async () => {
    calls++;
    if (calls === 2) await finalGate.promise;
    if (calls === 3) await retryGate.promise;
  });
  f.request('first');
  await vi.waitFor(() => expect(calls).toBe(2));
  f.resolve('first');
  finalGate.resolve();
  await vi.waitFor(() => expect(calls).toBe(3));
  f.revoke();
  retryGate.resolve();
  await vi.waitFor(() => expect(f.onClosed).toHaveBeenCalledOnce());
  expect(f.requestUserInput).toHaveBeenCalledOnce();
  expect(f.lease.close).toHaveBeenCalledOnce();
  f.noReply('first');
});

it.each(['ordinary abort', 'wrong resolved id'] as const)(
  'closes the actual owner for %s instead of treating it as trusted cleanup',
  async (failure) => {
    const f = await fixture();
    const controller = new AbortController();
    f.setQuestion(
      async (_params, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const pending = f.bridge.lifecycle.onRequest(
      'item/tool/requestUserInput',
      question('first'),
      controller.signal,
      { requestId: 'first' },
    );
    const rejected = expect(pending).rejects.toThrow('Owned Codex lifecycle unavailable');
    await vi.waitFor(() => expect(f.requestUserInput).toHaveBeenCalledOnce());
    controller.abort(
      failure === 'ordinary abort'
        ? new Error('Stopped')
        : new CodexServerRequestResolvedError('other'),
    );
    await rejected;
    expect(f.onClosed).toHaveBeenCalledOnce();
    expect(f.lease.close).toHaveBeenCalledOnce();
  },
);

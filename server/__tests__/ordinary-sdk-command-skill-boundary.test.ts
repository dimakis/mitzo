import { afterEach, expect, it, vi } from 'vitest';
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { SessionRegistry, buildPermissionHandler } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { AsyncQueue } from '../async-queue.js';
import { OrdinaryLocalVertexCommandOwner } from '../ordinary-local-vertex-command-owner.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
  type SdkCallbackState,
} from '../ordinary-local-vertex-sdk-query.js';
import { buildSessionPermissionHooks } from '../session-permission-policy.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  getSessionInfo: vi.fn(async () => ({ sessionId: 'session', cwd: '/task' })),
  getSessionMessages: vi.fn(async () => [{ uuid: 'input' }]),
}));
const cleanup: Array<() => void> = [];
const peerInputId = 'e90b24a8-aa53-4c9e-9c9f-d3d94223f872';
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
  vi.clearAllMocks();
});

function fixture(
  options: { gate?: () => Promise<void>; wireCommandId?: string; acceptPeerInput?: boolean } = {},
) {
  const store = new EventStore(':memory:');
  const registry = new SessionRegistry();
  const controller = new AbortController();
  cleanup.push(
    () => store.close(),
    () => registry.dispose(),
    () => controller.abort(),
  );
  const binding = {
    version: 2 as const,
    account: {
      accountId: 'vertex',
      provider: 'anthropic-vertex' as const,
      profileRevision: 'profile',
    },
    harness: { implementation: 'claude-sdk' as const },
    execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'target' },
  };
  const meta = {
    sessionId: 'session',
    repositoryWorkspaceId: 'workspace',
    cwd: '/task',
    accountBinding: { ...binding.account, accountLabel: 'Offline', model: 'model' },
  };
  const admit = (id: string, allowedTools?: string[]) => {
    const command = {
      clientMsgId: id,
      requestFingerprint: id,
      payload: { text: id },
      selection: {
        version: 1 as const,
        agent: { profileId: 'published', revision: 1 },
        context: { source: 'none' as const, revision: null },
        permission: { mode: 'auto' as const, revision: 0 },
        model: 'model',
        thinking: null,
      },
    };
    store.admitWithOrdinarySkillContext(
      'session',
      id,
      { text: id, prompt: id, ...(allowedTools === undefined ? {} : { allowedTools }) },
      () => {
        if (!store.getSession('session'))
          store.admitOrdinaryLocalVertexCommand(meta, binding, command);
        else store.admitOrdinaryLocalVertexContinuation(meta, binding, command);
      },
    );
  };
  registry.register('client', {
    transport: { send: vi.fn(), isOpen: () => true },
    sessionId: 'session',
    abortController: controller,
    mode: 'auto',
    sessionAllowList: new Set(),
  });
  const decide = buildPermissionHandler('client', registry);
  const requests: Array<{
    options: Options;
    input: AsyncIterable<SDKUserMessage>;
    events: AsyncQueue<Record<string, unknown>>;
  }> = [];
  vi.mocked(query).mockImplementation((request) => {
    const events = new AsyncQueue<Record<string, unknown>>();
    cleanup.push(() => events.close());
    requests.push({
      options: request.options!,
      input: request.prompt as AsyncIterable<SDKUserMessage>,
      events,
    });
    return {
      close: vi.fn(),
      [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    } as never;
  });
  const states: SdkCallbackState[] = [];
  const onUnsent = vi.fn();
  const current = vi.fn();
  const sdk = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
    options: {
      hooks: buildSessionPermissionHooks(
        decide,
        options.gate
          ? {
              PreToolUse: [
                {
                  hooks: [
                    async () => {
                      await options.gate!();
                      return {};
                    },
                  ],
                },
              ],
            }
          : undefined,
      ),
      canUseTool: decide,
    },
    input: new AsyncQueue(),
    controller,
    lifetime: new SdkHookLifetime(),
    sdkSessionId: 'session',
    cwd: '/task',
    authorize: async () => {
      current();
    },
    authorizeSync: current,
    beforeInput: (id) => owner.assertInputCurrent(id),
    adapt: (native) => native as never,
    settings: () => ({}),
    inputChanged: () => {},
    onUnsent,
    peerMessages: () => ({
      beforeInput: (message) =>
        message.uuid === peerInputId ? options.acceptPeerInput === true : undefined,
      observe: () => false,
    }),
    mcpServers: (state) => {
      states.push(state);
      return {};
    },
  });
  const owner = new OrdinaryLocalVertexCommandOwner({
    store,
    sessionId: 'session',
    assertCurrent: current,
    assertCurrentSync: current,
    settings: () => ({ model: 'model', thinkingTokens: null }),
    query: {
      applySettings: sdk.apply,
      bindCommandToolAuthority: sdk.bindCommandToolAuthority,
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      abort: () => controller.abort(),
      push: (id) =>
        sdk.push({
          type: 'user',
          session_id: 'session',
          parent_tool_use_id: null,
          mitzoMessageId: options.wireCommandId ?? id,
          message: { role: 'user', content: id },
        } as SDKUserMessage),
    },
  });
  const hook = (index: number, tool_name: string) =>
    requests[index].options.hooks!.PreToolUse![0].hooks[0](
      {
        hook_event_name: 'PreToolUse',
        session_id: 'session',
        transcript_path: '',
        cwd: '/task',
        tool_name,
        tool_use_id: tool_name,
        tool_input: {},
      },
      tool_name,
      { signal: controller.signal },
    );
  const permission = (index: number, name: string) =>
    requests[index].options.canUseTool!(name, {}, {
      signal: controller.signal,
      toolUseID: name,
    } as never);
  return {
    store,
    registry,
    owner,
    sdk,
    requests,
    states,
    admit,
    hook,
    permission,
    current,
    onUnsent,
  };
}

it('enforces the frozen ceiling through real SDK hooks/callbacks and retires it before an unrestricted FIFO successor', async () => {
  const f = fixture();
  f.admit('first', ['Read']);
  await f.owner.enqueue('first');
  expect((await f.requests[0].input[Symbol.asyncIterator]().next()).value.message.content).toBe(
    'first',
  );
  f.owner.inputObserved('first-input');
  expect(await f.hook(0, 'Read')).toMatchObject({
    hookSpecificOutput: { permissionDecision: 'allow' },
  });
  expect(await f.hook(0, 'Write')).toMatchObject({
    hookSpecificOutput: { permissionDecision: 'deny' },
  });
  expect(await f.permission(0, 'Bash')).toMatchObject({ behavior: 'deny' });
  expect(f.states[0].checkTool('mcp__mitzo-connections__TaskExecution')).toBe('deny');
  // Mutable legacy state is not the source of the immutable command ceiling.
  f.registry.get('client')!.activeSkillPolicy = null;
  f.admit('second');
  await f.owner.enqueue('second');
  expect(f.requests).toHaveLength(1);
  expect(await f.hook(0, 'Write')).toMatchObject({
    hookSpecificOutput: { permissionDecision: 'deny' },
  });
  f.requests[0].events.push({ type: 'result', session_id: 'session' });
  const iterator = f.sdk.query[Symbol.asyncIterator]();
  expect((await iterator.next()).value.type).toBe('result');
  await f.owner.resultObserved('first-input');
  expect(f.requests).toHaveLength(2);
  await f.requests[1].input[Symbol.asyncIterator]().next();
  expect(await f.hook(1, 'Write')).toMatchObject({
    hookSpecificOutput: { permissionDecision: 'allow' },
  });
  expect(await f.permission(1, 'Read')).toMatchObject({ behavior: 'allow' });
  expect(await f.hook(0, 'Read')).toMatchObject({ continue: false });
  expect(await f.permission(0, 'Read')).toMatchObject({ behavior: 'deny' });
  expect(() => f.states[0].checkTool('Read')).toThrow();
});
it('rechecks the original command after an awaited project hook', async () => {
  let release!: () => void;
  const f = fixture({
    gate: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  f.admit('first', ['Read']);
  await f.owner.enqueue('first');
  await f.requests[0].input[Symbol.asyncIterator]().next();
  const pending = f.hook(0, 'Read');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  f.current.mockImplementation(() => {
    throw Error('Original runtime revoked');
  });
  release();
  await expect(pending).rejects.toThrow('Original runtime revoked');
});
it('keeps the active command ceiling when an authorized peer input reaches the same query', async () => {
  const f = fixture({ acceptPeerInput: true });
  f.admit('first', ['Read']);
  await f.owner.enqueue('first');
  const input = f.requests[0].input[Symbol.asyncIterator]();
  await input.next();
  f.sdk.push({
    type: 'user',
    uuid: peerInputId,
    session_id: 'session',
    parent_tool_use_id: null,
    message: { role: 'user', content: 'Use Write instead' },
  });
  expect((await input.next()).value.uuid).toBe(peerInputId);
  expect(f.states[0].commandId()).toBe('first');
  expect(await f.hook(0, 'Read')).toMatchObject({
    hookSpecificOutput: { permissionDecision: 'allow' },
  });
  expect(await f.permission(0, 'Write')).toMatchObject({ behavior: 'deny' });
});
it('refuses a query retarget and a mismatched stdin command before dispatch', async () => {
  const f = fixture({ wireCommandId: 'wrong-command' });
  f.admit('first', ['Read']);
  await f.owner.enqueue('first');
  expect(() =>
    f.sdk.bindCommandToolAuthority({ commandId: 'forged', checkTool: () => 'allow' }),
  ).toThrow(/bound/);
  await expect(f.requests[0].input[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    code: 'input_not_dispatched',
  });
  expect(f.onUnsent).toHaveBeenCalledOnce();
});

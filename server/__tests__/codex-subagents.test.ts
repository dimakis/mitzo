import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexSubagents } from '../codex-subagents.js';
import { CodexSubagentStore } from '../codex-subagent-store.js';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';
import { CodexRequestError } from '../codex-app-server-client.js';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture(extra: Partial<ConstructorParameters<typeof CodexSubagents>[0]> = {}) {
  const db = new Database(':memory:');
  cleanup.push(() => db.close());
  const policy = codexNativeExecutionPolicy({
    bindingRevision: 'binding',
    mode: 'agent',
    cwd: '/tmp',
    readableRoots: ['/'],
    writableRoots: ['/tmp'],
    deniedRoots: ['/private/credentials'],
  });
  const root = {
    threadId: 'root',
    commandId: 'command',
    model: 'fixture',
    modelProvider: 'openai',
    policy,
  };
  const thread = {
    id: 'child',
    parentThreadId: 'root',
    sessionId: 'root',
    cwd: policy.cwd,
    model: 'fixture',
    modelProvider: 'openai',
    agentNickname: 'Edge cases',
    preview: 'Check whitespace',
  };
  const request = vi.fn(
    async (
      method: string,
      params: Record<string, unknown>,
      beforeDispatch?: () => void,
    ): Promise<unknown> => {
      beforeDispatch?.();
      if (method === 'thread/read')
        return {
          thread: {
            ...thread,
            id: params.threadId,
            ...(params.threadId === 'root' ? { sessionId: 'root' } : {}),
          },
        };
      if (method === 'thread/resume')
        return {
          thread: { ...thread, id: params.threadId },
          model: 'fixture',
          modelProvider: 'openai',
        };
      if (method === 'thread/turns/list') return { data: [], nextCursor: null };
      if (method === 'turn/steer') return { turnId: params.expectedTurnId };
      if (method === 'turn/start') return { turn: { id: 'new-turn' } };
      return {};
    },
  );
  const execute = vi.fn<ConstructorParameters<typeof CodexSubagents>[0]['executeTool']>(
    async () => ({ content: 'Result', isError: false }),
  );
  const approval = vi.fn<
    NonNullable<ConstructorParameters<typeof CodexSubagents>[0]['requestNativeApproval']>
  >(async () => ({ decision: 'accept' }));
  const assertCurrent = vi.fn();
  const onChild = vi.fn();
  const options = {
    scope: { conversationId: 'conversation', bindingRevision: 'binding' },
    store: new CodexSubagentStore(db),
    root: () => root,
    assertCurrent,
    request,
    executeTool: execute,
    requestNativeApproval: approval,
    onChild,
    tools: [{ name: 'Read', description: 'Read', input_schema: { type: 'object' } }],
    validateModel: (model: string) => {
      if (model !== 'fixture') throw Error('Wrong model');
    },
    ...extra,
  };
  const owner = new CodexSubagents(options);
  cleanup.push(() => owner.close());
  const notify = (method: string, params: Record<string, unknown>) =>
    owner.notification(method, params);
  async function admit() {
    notify('thread/started', { thread });
    notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
    await owner.settled();
  }
  return {
    owner,
    options,
    root,
    thread,
    request,
    execute,
    approval,
    assertCurrent,
    onChild,
    notify,
    admit,
  };
}
it('qualifies native activity hints through the original parent and native child identity', async () => {
  const f = fixture();
  const activity = {
    type: 'subAgentActivity',
    id: 'spawn',
    kind: 'started',
    agentThreadId: 'child',
    agentPath: '/root/reviewer',
  };
  for (const [threadId, item] of [
    ['foreign', activity],
    ['root', { ...activity, kind: 'future' }],
    ['root', { ...activity, agentThreadId: '' }],
  ] as const)
    f.notify('item/completed', { threadId, item });
  await f.owner.settled();
  expect(f.request).not.toHaveBeenCalled();
  f.thread.parentThreadId = 'foreign';
  f.notify('item/completed', { threadId: 'root', item: activity });
  await f.owner.settled();
  expect(f.owner.list()).toEqual([]);
  expect(f.request.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false);
  f.thread.parentThreadId = 'root';
  f.notify('item/completed', { threadId: 'root', item: activity });
  f.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  await f.owner.settled();
  expect(f.owner.list()).toEqual([
    expect.objectContaining({ threadId: 'child', state: 'working' }),
  ]);
  expect(f.execute).not.toHaveBeenCalled();
});

it('hydrates nonempty paginated history entries in order without replaying tools', async () => {
  const f = fixture();
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (method, params, beforeDispatch) => {
    if (method === 'thread/turns/list')
      return { data: [{ id: 'past', status: 'completed' }], nextCursor: null };
    if (method === 'thread/items/list') {
      expect(params.sortDirection).toBe('asc');
      return {
        data: [
          {
            turnId: 'past',
            completedAtMs: 1,
            item: params.cursor
              ? {
                  id: 'tool',
                  type: 'dynamicToolCall',
                  tool: 'Read',
                  arguments: {},
                  contentItems: [{ type: 'inputText', text: 'Retained result' }],
                  status: 'completed',
                }
              : { id: 'message', type: 'agentMessage', text: 'Retained answer' },
          },
        ],
        nextCursor: params.cursor ? null : 'next',
      };
    }
    return original(method, params, beforeDispatch);
  });
  f.notify('thread/started', { thread: f.thread });
  await f.owner.settled();
  expect(f.owner.list()[0]).toMatchObject({
    state: 'completed',
    blocks: [
      { id: 'message', content: 'Retained answer' },
      { id: 'tool', content: 'Retained result', status: 'completed' },
    ],
  });
  expect(f.execute).not.toHaveBeenCalled();
});
it('preserves completion and late task attribution when admission buffers fill', async () => {
  const f = fixture();
  f.notify('thread/started', { thread: f.thread });
  f.notify('item/started', {
    threadId: 'root',
    item: {
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      senderThreadId: 'root',
      receiverThreadIds: ['child'],
      prompt: 'Full assigned task',
    },
  });
  f.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  for (let index = 0; index < 300; index++)
    f.notify('item/agentMessage/delta', {
      threadId: 'child',
      turnId: 'child-turn',
      itemId: 'message',
      delta: 'x',
    });
  f.notify('turn/completed', {
    threadId: 'child',
    turn: { id: 'child-turn', status: 'completed' },
  });
  await f.owner.settled();
  expect(f.owner.list()[0]).toMatchObject({
    state: 'completed',
    task: 'Full assigned task',
    outputTruncated: true,
  });
});
it('attributes descendants to the spawning child after the root starts another command', async () => {
  const f = fixture();
  await f.admit();
  f.root.commandId = 'next-command';
  f.notify('thread/started', {
    thread: { ...f.thread, id: 'grandchild', parentThreadId: 'child' },
  });
  // The native metadata read must confirm the same attributed parent.
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (method, params, beforeDispatch) => {
    const response = await original(method, params, beforeDispatch);
    return method === 'thread/read' && params.threadId === 'grandchild'
      ? { thread: { ...f.thread, id: 'grandchild', parentThreadId: 'child' } }
      : response;
  });
  await f.owner.settled();
  expect(f.owner.list().find((child) => child.threadId === 'grandchild')).toMatchObject({
    commandId: 'command',
  });
});
it.each(['message', 'stop'] as const)(
  'restores usable state after a definitive %s rejection',
  async (action) => {
    const f = fixture();
    await f.admit();
    if (action === 'message')
      f.notify('turn/completed', {
        threadId: 'child',
        turn: { id: 'child-turn', status: 'completed' },
      });
    const originalState = f.owner.list()[0].state;
    f.request.mockImplementationOnce(async (method, _params, beforeDispatch) => {
      beforeDispatch?.();
      throw new CodexRequestError(method, 'invalid_request');
    });
    expect(
      await f.owner.control(
        action === 'message'
          ? { requestId: 'reject', action, threadId: 'child', text: 'Try' }
          : { requestId: 'reject', action, threadId: 'child' },
      ),
    ).toBe('rejected');
    expect(f.owner.list()[0].state).toBe(originalState);
  },
);
it('restores rejected interruption state despite concurrent output while retaining that output', async () => {
  const f = fixture();
  await f.admit();
  f.request.mockImplementationOnce(async (method, _params, beforeDispatch) => {
    beforeDispatch?.();
    f.notify('item/agentMessage/delta', {
      threadId: 'child',
      turnId: 'child-turn',
      itemId: 'during-stop',
      delta: 'Output during interruption',
    });
    throw new CodexRequestError(method, 'invalid_request');
  });
  expect(await f.owner.control({ requestId: 'stop', action: 'stop', threadId: 'child' })).toBe(
    'rejected',
  );
  expect(f.owner.list()[0]).toMatchObject({
    state: 'working',
    blocks: [{ content: 'Output during interruption' }],
  });
});
it.each([false, true])(
  'refuses a prepared child message after parent Stop, including after resume (%s)',
  async (resumed) => {
    const f = fixture();
    await f.admit();
    f.notify('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'completed' },
    });
    let release!: () => void;
    let dispatched = false;
    f.request.mockImplementationOnce(async (_method, _params, beforeDispatch) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      beforeDispatch?.();
      dispatched = true;
      return { turn: { id: 'forbidden-late-turn' } };
    });
    const directed = f.owner.control({
      requestId: 'message',
      action: 'message',
      threadId: 'child',
      text: 'Next check',
    });
    await f.owner.interruptAll();
    if (resumed) f.owner.parentResumed();
    release();
    expect(await directed).toBe('rejected');
    expect(dispatched).toBe(false);
    expect(f.owner.list()[0]).toMatchObject({ state: 'completed', available: resumed });
    f.owner.parentResumed();
    expect(f.owner.list()[0].available).toBe(true);
  },
);
it('does not overwrite a native terminal event while rolling back an interrupt rejection', async () => {
  const f = fixture();
  await f.admit();
  f.request.mockImplementationOnce(async (method, _params, beforeDispatch) => {
    beforeDispatch?.();
    f.notify('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'completed' },
    });
    throw new CodexRequestError(method, 'invalid_request');
  });
  await f.owner.control({ requestId: 'stop', action: 'stop', threadId: 'child' });
  expect(f.owner.list()[0].state).toBe('completed');
});
it('preserves executor output when native dynamic-tool completion follows its callback', async () => {
  const f = fixture();
  await f.admit();
  await f.owner.request(
    'item/tool/call',
    { threadId: 'child', turnId: 'child-turn', callId: 'call', tool: 'Read', arguments: {} },
    new AbortController().signal,
  );
  f.notify('item/completed', {
    threadId: 'child',
    turnId: 'child-turn',
    item: {
      id: 'call',
      type: 'dynamicToolCall',
      tool: 'Read',
      contentItems: [
        { type: 'inputText', text: 'Native summary must not replace executor output' },
      ],
      arguments: {},
      status: 'completed',
      success: true,
    },
  });
  expect(f.owner.list()[0].blocks.find((block) => block.id === 'call')).toMatchObject({
    content: 'Result',
    name: 'Read',
    status: 'completed',
  });
});
it('admits only children from the owned native session tree and checks selected model and cwd', async () => {
  const f = fixture();
  f.notify('thread/started', { thread: { ...f.thread, parentThreadId: 'stranger' } });
  await f.owner.settled();
  expect(f.request).not.toHaveBeenCalled();
  await f.admit();
  expect(f.owner.list()[0]).toMatchObject({
    threadId: 'child',
    name: 'Edge cases',
    state: 'working',
    turnId: 'child-turn',
  });
  expect(f.onChild).toHaveBeenCalledOnce();
});
it.each(['cwd', 'model', 'sessionId'] as const)(
  'refuses child %s changes before admitting executable callbacks',
  async (key) => {
    const f = fixture();
    Object.assign(f.thread, { [key]: 'foreign' });
    await f.admit();
    expect(f.owner.list()).toEqual([]);
    await expect(
      f.owner.request(
        'item/tool/call',
        { threadId: 'child', turnId: 'child-turn', callId: 'call', tool: 'Read', arguments: {} },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it('buffers early child events, replaces final text and never completes the parent queue', async () => {
  const f = fixture();
  await f.admit();
  f.notify('item/agentMessage/delta', {
    threadId: 'child',
    turnId: 'child-turn',
    itemId: 'message',
    delta: 'Checking',
  });
  f.notify('item/completed', {
    threadId: 'child',
    turnId: 'child-turn',
    item: { id: 'message', type: 'agentMessage', text: 'Checking edge cases.' },
  });
  f.notify('turn/completed', {
    threadId: 'child',
    turn: { id: 'child-turn', status: 'completed' },
  });
  expect(f.owner.list()[0]).toMatchObject({
    state: 'completed',
    blocks: [{ id: 'message', type: 'text', content: 'Checking edge cases.' }],
  });
  f.notify('item/agentMessage/delta', {
    threadId: 'child',
    turnId: 'child-turn',
    itemId: 'late',
    delta: 'stale',
  });
  expect(f.owner.list()[0].blocks).toHaveLength(1);
});
it('steers an active child with the exact turn fence and deduplicates the request', async () => {
  const f = fixture();
  await f.admit();
  const input = {
    requestId: 'message',
    threadId: 'child',
    action: 'message' as const,
    text: 'Check whitespace',
  };
  expect(await f.owner.control(input)).toBe('accepted');
  expect(await f.owner.control(input)).toBe('accepted');
  expect(
    f.request.mock.calls
      .filter(([method]) => method === 'turn/steer')
      .map(([method, params]) => [method, params]),
  ).toEqual([
    [
      'turn/steer',
      {
        threadId: 'child',
        expectedTurnId: 'child-turn',
        input: [{ type: 'text', text: input.text }],
      },
    ],
  ]);
});
it('starts an ordinary idle-child turn and never steers the completed turn', async () => {
  const f = fixture();
  await f.admit();
  f.notify('turn/completed', {
    threadId: 'child',
    turn: { id: 'child-turn', status: 'completed' },
  });
  expect(
    await f.owner.control({
      requestId: 'idle',
      threadId: 'child',
      action: 'message',
      text: 'One more check',
    }),
  ).toBe('accepted');
  expect(f.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  expect(f.request.mock.calls.filter(([method]) => method === 'turn/steer')).toHaveLength(0);
  expect(f.owner.list()[0]).toMatchObject({ state: 'working', turnId: 'new-turn' });
});
it('retains uncertainty after a lost control reply and never resends it', async () => {
  const f = fixture();
  await f.admit();
  f.request.mockImplementationOnce(async (_method, _params, beforeDispatch) => {
    beforeDispatch?.();
    throw Error('Disconnected after write');
  });
  const input = {
    requestId: 'uncertain',
    threadId: 'child',
    action: 'message' as const,
    text: 'Check',
  };
  expect(await f.owner.control(input)).toBe('uncertain');
  f.owner.close();
  expect(await f.owner.control(input)).toBe('uncertain');
  expect(f.request.mock.calls.filter(([method]) => method === 'turn/steer')).toHaveLength(1);
});
it('fences child tools at completion and replays only a durably known result', async () => {
  const f = fixture();
  await f.admit();
  const params = {
    threadId: 'child',
    turnId: 'child-turn',
    callId: 'call',
    tool: 'Read',
    arguments: { path: '/tmp/file' },
  };
  const signal = new AbortController().signal;
  await f.owner.request('item/tool/call', params, signal);
  await f.owner.request('item/tool/call', params, signal);
  expect(f.execute).toHaveBeenCalledOnce();
  f.notify('turn/completed', {
    threadId: 'child',
    turn: { id: 'child-turn', status: 'completed' },
  });
  await expect(
    f.owner.request('item/tool/call', { ...params, callId: 'late' }, signal),
  ).rejects.toThrow();
  expect(f.execute).toHaveBeenCalledOnce();
});
it('routes attributed native approvals through the existing permission owner and rechecks after await', async () => {
  const f = fixture();
  await f.admit();
  let finish!: (result: Record<string, unknown>) => void;
  f.approval.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.owner.request(
    'item/commandExecution/requestApproval',
    { threadId: 'child', turnId: 'child-turn', itemId: 'command' },
    new AbortController().signal,
    { requestId: 7 },
  );
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(f.approval.mock.calls[0][3]).toMatchObject({
    subagentName: 'Edge cases',
    threadId: 'child',
    turnId: 'child-turn',
  });
  f.root.policy = { ...f.root.policy, policyRevision: 'revoked' };
  finish({ decision: 'accept' });
  await expect(pending).rejects.toThrow();
});
it('does not let approval cleanup overwrite a Stop waiting for dispatch', async () => {
  const f = fixture();
  await f.admit();
  let approve!: (value: Record<string, unknown>) => void;
  f.approval.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        approve = resolve;
      }),
  );
  const approval = f.owner
    .request(
      'item/commandExecution/requestApproval',
      { threadId: 'child', turnId: 'child-turn', itemId: 'command' },
      new AbortController().signal,
      { requestId: 77 },
    )
    .catch(() => undefined);
  await vi.waitFor(() => expect(approve).toBeDefined());
  const original = f.request.getMockImplementation()!;
  let release!: () => void;
  let dispatched = false;
  f.request.mockImplementation(async (method, params, beforeDispatch) => {
    if (method !== 'turn/interrupt') return original(method, params, beforeDispatch);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    beforeDispatch?.();
    dispatched = true;
    return {};
  });
  const stopping = f.owner.control({
    requestId: 'approval-stop',
    threadId: 'child',
    action: 'stop',
  });
  await vi.waitFor(() => expect(release).toBeDefined());
  approve({ decision: 'accept' });
  await approval;
  expect(f.owner.list()[0].state).toBe('stopping');
  release();
  expect(await stopping).toBe('accepted');
  expect(dispatched).toBe(true);
});
it('interrupts admissions arriving during and after the parent cancellation sweep', async () => {
  const f = fixture();
  await f.admit();
  const original = f.request.getMockImplementation()!;
  let release!: () => void;
  const interrupted: string[] = [];
  f.request.mockImplementation(async (method, params, beforeDispatch) => {
    if (method !== 'turn/interrupt') return original(method, params, beforeDispatch);
    if (params.threadId === 'child')
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    beforeDispatch?.();
    interrupted.push(String(params.threadId));
    return {};
  });
  const stopping = f.owner.interruptAll();
  await vi.waitFor(() => expect(release).toBeDefined());
  const late = (threadId: string) => {
    f.notify('thread/started', { thread: { ...f.thread, id: threadId } });
    f.notify('turn/started', { threadId, turn: { id: threadId + '-turn' } });
  };
  late('during');
  release();
  await stopping;
  expect(interrupted).toEqual(expect.arrayContaining(['child', 'during']));
  late('after');
  await f.owner.settled();
  await vi.waitFor(() => expect(interrupted).toContain('after'));
  expect(f.owner.list().every((child) => !child.available)).toBe(true);
});
it('evicts inactive live children without losing saved output or later Message controls', async () => {
  const f = fixture();
  for (let index = 0; index < 40; index++) {
    const threadId = `sequential-${index}`,
      turnId = `turn-${index}`;
    f.notify('thread/started', { thread: { ...f.thread, id: threadId } });
    f.notify('turn/started', { threadId, turn: { id: turnId } });
    await f.owner.settled();
    f.notify('item/agentMessage/delta', {
      threadId,
      turnId,
      itemId: 'text',
      delta: `Output ${index}`,
    });
    f.notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  }
  const children = f.owner.list();
  expect(children).toHaveLength(40);
  expect(children[0]).toMatchObject({
    state: 'completed',
    available: true,
    blocks: [{ content: 'Output 0' }],
  });
  expect(
    f.request.mock.calls.filter(
      ([method, params]) => method === 'thread/read' && params.threadId === 'sequential-0',
    ),
  ).toHaveLength(1);
  expect(
    await f.owner.control({
      requestId: 'revisit',
      threadId: 'sequential-0',
      action: 'message',
      text: 'Continue',
    }),
  ).toBe('accepted');
  expect(f.owner.list().find((child) => child.threadId === 'sequential-0')?.state).toBe('working');
  expect(
    f.request.mock.calls.filter(
      ([method, params]) => method === 'thread/read' && params.threadId === 'sequential-0',
    ),
  ).toHaveLength(2);
});
it('keeps cancellation authority for a pending admission even if the parent resumes first', async () => {
  const f = fixture();
  await f.admit();
  const original = f.request.getMockImplementation()!;
  let release!: () => void;
  f.request.mockImplementation(async (method, params, beforeDispatch) => {
    if (method === 'thread/read' && params.threadId === 'late-resume')
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return original(method, params, beforeDispatch);
  });
  f.notify('thread/started', { thread: { ...f.thread, id: 'late-resume' } });
  f.notify('turn/started', { threadId: 'late-resume', turn: { id: 'late-turn' } });
  await vi.waitFor(() => expect(release).toBeDefined());
  const stopping = f.owner.interruptAll();
  f.owner.parentResumed();
  release();
  await stopping;
  expect(
    f.request.mock.calls.some(
      ([method, params]) => method === 'turn/interrupt' && params.threadId === 'late-resume',
    ),
  ).toBe(true);
  expect(f.owner.list().find((child) => child.threadId === 'late-resume')?.state).toBe('stopping');
});
it('allows a fresh Message to a previously completed child after the parent resumes', async () => {
  const f = fixture();
  await f.admit();
  f.notify('turn/completed', {
    threadId: 'child',
    turn: { id: 'child-turn', status: 'completed' },
  });
  await f.owner.interruptAll();
  f.owner.parentResumed();
  expect(
    await f.owner.control({
      requestId: 'fresh-after-stop',
      threadId: 'child',
      action: 'message',
      text: 'Continue',
    }),
  ).toBe('accepted');
  expect(f.owner.list()[0].state).toBe('working');
  expect(f.request.mock.calls.filter(([method]) => method === 'turn/interrupt')).toHaveLength(0);
});
it('takes over a child Stop still preparing when parent cancellation starts', async () => {
  const f = fixture();
  await f.admit();
  const original = f.request.getMockImplementation()!;
  let release!: () => void;
  const dispatched: string[] = [];
  let first = true;
  f.request.mockImplementation(async (method, params, beforeDispatch) => {
    if (method !== 'turn/interrupt') return original(method, params, beforeDispatch);
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    beforeDispatch?.();
    dispatched.push(String(params.threadId));
    return {};
  });
  const childStop = f.owner.control({
    requestId: 'child-stop-first',
    threadId: 'child',
    action: 'stop',
  });
  await vi.waitFor(() => expect(release).toBeDefined());
  const parentStop = f.owner.interruptAll();
  await parentStop;
  release();
  expect(await childStop).toBe('rejected');
  expect(dispatched).toEqual(['child']);
  expect(f.owner.list()[0].state).toBe('stopping');
});
it('retains exact private child claims and original base reads only for the genuine callback', async () => {
  const f = fixture({ nativeOrigin: () => ({ commandId: 'command', attempt: 1, generation: 0 }) });
  await f.admit();
  let captured: (() => unknown) | undefined;
  f.execute.mockImplementationOnce(async (tool, input, _signal, call) => {
    const scope = call.captureNativeBaseReadScope!();
    expect(scope.nativeTarget).toMatchObject({
      threadId: 'child',
      turnId: 'child-turn',
      commandId: 'command',
    });
    const identity = { turnId: call.turnId, toolName: tool, requestHash: scope.requestHash };
    expect(f.owner.pendingHostTool(call, identity)?.callId).toBe(call.callId);
    expect(f.owner.pendingHostTool({ ...call }, identity)).toBeUndefined();
    expect(Object.keys(call)).toEqual(['turnId', 'callId']);
    captured = scope.assertCurrentSync;
    captured();
    expect(Object.isFrozen(scope.readableRoots)).toBe(true);
    input.changed = true;
    expect(captured).toThrow();
    delete input.changed;
    return { content: 'Read succeeded', isError: false };
  });
  const response = await f.owner.request(
    'item/tool/call',
    {
      threadId: 'child',
      turnId: 'child-turn',
      callId: 'private-child-read',
      tool: 'Read',
      arguments: {},
    },
    new AbortController().signal,
  );
  expect(response.success).toBe(true);
  expect(captured).toThrow();
});
it('targets Stop to one child and waits for the native terminal acknowledgement', async () => {
  const f = fixture();
  await f.admit();
  expect(await f.owner.control({ requestId: 'stop', threadId: 'child', action: 'stop' })).toBe(
    'accepted',
  );
  expect(f.owner.list()[0].state).toBe('stopping');
  expect(f.request.mock.calls.at(-1)?.slice(0, 2)).toEqual([
    'turn/interrupt',
    { threadId: 'child', turnId: 'child-turn' },
  ]);
  f.notify('turn/completed', {
    threadId: 'child',
    turn: { id: 'child-turn', status: 'interrupted' },
  });
  expect(f.owner.list()[0].state).toBe('stopped');
});
it('does not expose raw reasoning or provider error payloads in child output', async () => {
  const f = fixture();
  await f.admit();
  f.notify('item/reasoning/textDelta', {
    threadId: 'child',
    turnId: 'child-turn',
    itemId: 'reasoning',
    delta: 'private reasoning',
  });
  f.notify('turn/completed', {
    threadId: 'child',
    turn: { id: 'child-turn', status: 'failed', error: { message: 'Bearer secret' } },
  });
  expect(JSON.stringify(f.owner.list())).not.toMatch(/private reasoning|Bearer secret/);
  expect(f.owner.list()[0].state).toBe('failed');
});
it('preserves child output but disables execution when its transport closes', async () => {
  const f = fixture();
  await f.admit();
  f.owner.close();
  expect(f.owner.list()[0].state).toBe('unknown');
  expect(
    await f.owner.control({
      requestId: 'closed',
      threadId: 'child',
      action: 'message',
      text: 'Check',
    }),
  ).toBe('rejected');
  expect(f.execute).not.toHaveBeenCalled();
});
it('does not regain a child tool authority merely by restoring a retained running snapshot', async () => {
  const f = fixture();
  await f.admit();
  f.owner.close();
  const restored = new CodexSubagents(f.options);
  try {
    await restored.restore();
    expect(restored.list()[0].state).toBe('unknown');
    await expect(
      restored.request(
        'item/tool/call',
        {
          threadId: 'child',
          turnId: 'child-turn',
          callId: 'after-loss',
          tool: 'Read',
          arguments: {},
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  } finally {
    restored.close();
  }
});
it('stops every admitted child when the parent is interrupted', async () => {
  const f = fixture();
  await f.admit();
  f.notify('thread/started', { thread: { ...f.thread, id: 'sibling' } });
  f.notify('turn/started', { threadId: 'sibling', turn: { id: 'sibling-turn' } });
  await f.owner.settled();
  await f.owner.interruptAll();
  expect(
    f.request.mock.calls
      .filter(([method]) => method === 'turn/interrupt')
      .map(([method, params]) => [method, params]),
  ).toEqual([
    ['turn/interrupt', { threadId: 'child', turnId: 'child-turn' }],
    ['turn/interrupt', { threadId: 'sibling', turnId: 'sibling-turn' }],
  ]);
});
it('refuses permission delivery if the exact child file-change proposal changes during review', async () => {
  const f = fixture();
  await f.admit();
  f.notify('item/started', {
    threadId: 'child',
    turnId: 'child-turn',
    item: {
      id: 'edit',
      type: 'fileChange',
      changes: [{ path: '/tmp/a', kind: { type: 'add' }, diff: '+first' }],
    },
  });
  let finish!: (value: Record<string, unknown>) => void;
  f.approval.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.owner.request(
    'item/fileChange/requestApproval',
    { threadId: 'child', turnId: 'child-turn', itemId: 'edit' },
    new AbortController().signal,
    { requestId: 8 },
  );
  await vi.waitFor(() => expect(finish).toBeDefined());
  f.notify('item/started', {
    threadId: 'child',
    turnId: 'child-turn',
    item: {
      id: 'edit',
      type: 'fileChange',
      changes: [{ path: '/tmp/b', kind: { type: 'add' }, diff: '+second' }],
    },
  });
  finish({ decision: 'accept' });
  await expect(pending).rejects.toThrow();
});

it('retains deployment cancellation authority through delayed child control I/O', async () => {
  const f = fixture();
  await f.admit();
  const original = f.request.getMockImplementation()!;
  let release!: () => void,
    authorized = true,
    dispatched = false;
  f.request.mockImplementation(async (method, params, beforeDispatch) => {
    if (method !== 'turn/interrupt') return original(method, params, beforeDispatch);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    beforeDispatch?.();
    dispatched = true;
    return {};
  });
  const stopping = f.owner.interruptAll(() => {
    if (!authorized) throw Error('Deployment operator revoked');
  });
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(f.owner.hasPendingActivity()).toBe(true);
  authorized = false;
  release();
  await stopping;
  expect(dispatched).toBe(false);
  expect(f.owner.list()[0]!.state).not.toBe('completed');
});

import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexSubagents } from '../codex-subagents.js';
import { CodexSubagentStore } from '../codex-subagent-store.js';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture() {
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
    async (method: string, params: Record<string, unknown>): Promise<unknown> => {
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
  const execute = vi.fn(async () => ({ content: 'Result', isError: false }));
  const approval = vi.fn(async () => ({ decision: 'accept' }));
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
  expect(f.request.mock.calls.filter(([method]) => method === 'turn/steer')).toEqual([
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
  f.request.mockImplementationOnce(async () => {
    throw Error('Disconnected after write');
  });
  const input = {
    requestId: 'uncertain',
    threadId: 'child',
    action: 'message' as const,
    text: 'Check',
  };
  expect(await f.owner.control(input)).toBe('uncertain');
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
it('targets Stop to one child and waits for the native terminal acknowledgement', async () => {
  const f = fixture();
  await f.admit();
  expect(await f.owner.control({ requestId: 'stop', threadId: 'child', action: 'stop' })).toBe(
    'accepted',
  );
  expect(f.owner.list()[0].state).toBe('stopping');
  expect(f.request.mock.calls.at(-1)).toEqual([
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
  expect(f.request.mock.calls.filter(([method]) => method === 'turn/interrupt')).toEqual([
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

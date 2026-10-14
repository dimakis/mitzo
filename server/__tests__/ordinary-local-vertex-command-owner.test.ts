import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import type { OrdinaryLocalCommandAdmission } from '../../packages/protocol/src/ordinary-local-admission.js';
import { OrdinaryLocalVertexCommandOwner } from '../ordinary-local-vertex-command-owner.js';
const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const binding = {
  version: 2 as const,
  account: {
    accountId: 'vertex',
    provider: 'anthropic-vertex' as const,
    profileRevision: 'exact-profile',
  },
  harness: { implementation: 'claude-sdk' as const },
  execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'exact-target' },
};
const meta = {
  sessionId: 'session',
  repositoryWorkspaceId: 'workspace',
  cwd: '/fixture',
  accountBinding: { ...binding.account, accountLabel: 'Vertex', model: 'first' },
};
const command = (id: string, model = 'first') => ({
  clientMsgId: id,
  requestFingerprint: `exact-${id}`,
  payload: { text: id },
  selection: {
    version: 1 as const,
    agent: { profileId: 'published', revision: 1 },
    context: { source: 'none' as const, revision: null },
    permission: { mode: 'ask' as const, revision: 0 },
    model,
    thinking: model === 'first' ? null : 'enabled',
  },
});
function setup() {
  const store = new EventStore(':memory:');
  stores.push(store);
  store.admitOrdinaryLocalVertexCommand(meta, binding, command('first'));
  const calls: string[] = [];
  const assertCurrent = vi.fn();
  const query = {
    applySettings: undefined as
      ((selection: OrdinaryLocalCommandAdmission['selection']) => Promise<void>) | undefined,
    setModel: vi.fn(async (model: string) => {
      calls.push(`model:${model}`);
    }),
    setMaxThinkingTokens: vi.fn(async (tokens: number | null) => {
      calls.push(`thinking:${tokens}`);
    }),
    push: vi.fn(
      async (
        id: string,
        _admission: Readonly<OrdinaryLocalCommandAdmission>,
        _payload: Readonly<Record<string, unknown>>,
      ) => {
        calls.push(`push:${id}`);
      },
    ),
    abort: vi.fn(),
  };
  const owner = new OrdinaryLocalVertexCommandOwner({
    store,
    sessionId: 'session',
    assertCurrent,
    ownsClaim: (id) => store.getOrdinaryLocalVertexCommandAdmission(id)?.state === 'consumed',
    query,
    settings: (selection) => ({
      model: selection.model,
      thinkingTokens: selection.thinking === null ? null : 10000,
    }),
  });
  return { store, owner, calls, query, assertCurrent };
}
it('changes SDK settings only between terminal commands and preserves queued snapshots', async () => {
  const { store, owner, calls, query } = setup();
  await owner.enqueue('first');
  store.admitOrdinaryLocalVertexContinuation(
    { ...meta, accountBinding: { ...meta.accountBinding, model: 'second' } },
    binding,
    command('second', 'second'),
  );
  await owner.enqueue('second');
  expect(calls).toEqual(['model:first', 'thinking:null', 'push:first']);
  expect(store.getOrdinaryLocalVertexCommandAdmission('second')?.state).toBe('reserved');
  expect(store.getExecutionAdmission('session', 'second')).toBeUndefined();
  await owner.complete('first');
  expect(calls).toEqual([
    'model:first',
    'thinking:null',
    'push:first',
    'model:second',
    'thinking:10000',
    'push:second',
  ]);
  expect(query.push.mock.calls[1][1].selection.model).toBe('second');
  expect(store.getOrdinaryLocalVertexCommandAdmission('first')?.selection.model).toBe('first');
  expect(store.getOrdinaryLocalVertexCommandAdmission('second')?.state).toBe('consumed');
});
it('refuses revoked authority between SDK control acknowledgements without yielding or retrying input', async () => {
  const { store, owner, query, assertCurrent } = setup();
  query.setModel.mockImplementation(async () => {
    assertCurrent.mockImplementation(() => {
      throw Error('revoked');
    });
  });
  await expect(owner.enqueue('first')).rejects.toThrow('revoked');
  expect(query.setMaxThinkingTokens).not.toHaveBeenCalled();
  expect(query.push).not.toHaveBeenCalled();
  expect(query.abort).toHaveBeenCalled();
  expect(store.getOrdinaryLocalVertexCommandAdmission('first')?.state).toBe('uncertain');
  await expect(owner.enqueue('first')).rejects.toThrow();
  expect(query.setModel).toHaveBeenCalledTimes(1);
});
it('rejects foreign result identity before changing running settings', async () => {
  const { owner, query } = setup();
  await owner.enqueue('first');
  await expect(owner.complete('foreign')).rejects.toThrow(
    'SDK result does not match active command',
  );
  expect(query.setModel).toHaveBeenCalledTimes(1);
  expect(query.abort).toHaveBeenCalled();
});

it.each([false, true])(
  'preserves old active and queued SDK work on request cancellation unless original authority is lost (%s)',
  async (revoked) => {
    const { store, owner, query, calls, assertCurrent } = setup();
    await owner.enqueue('first');
    store.admitOrdinaryLocalVertexContinuation(
      { ...meta, accountBinding: { ...meta.accountBinding, model: 'second' } },
      binding,
      command('accepted', 'second'),
    );
    await owner.enqueue('accepted');
    store.admitOrdinaryLocalVertexContinuation(meta, binding, command('expired'));
    let release!: () => void,
      waiting = false;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    assertCurrent.mockImplementationOnce(async () => {
      waiting = true;
      await deferred;
    });
    const controller = new AbortController();
    const pending = owner.enqueue('expired', controller.signal);
    const observed = pending.then(
      () => 'accepted',
      () => 'refused',
    );
    await vi.waitFor(() => expect(waiting).toBe(true));
    controller.abort(new Error('Incoming admission deadline'));
    if (revoked)
      assertCurrent.mockImplementation(() => {
        throw Error('Original ADC authority revoked');
      });
    release();
    expect(await observed).toBe('refused');
    expect(store.getExecutionAdmission('session', 'expired')).toBeUndefined();
    expect(store.getOrdinaryLocalVertexCommandAdmission('expired')?.state).toBe('reserved');
    expect(calls).toEqual(['model:first', 'thinking:null', 'push:first']);
    if (revoked) {
      expect(query.abort).toHaveBeenCalledOnce();
      await expect(owner.complete('first')).rejects.toThrow();
    } else {
      expect(query.abort).not.toHaveBeenCalled();
      await owner.complete('first');
      expect(query.push.mock.calls.map(([id]) => id)).toEqual(['first', 'accepted']);
      await owner.complete('accepted');
      expect(query.push.mock.calls.map(([id]) => id)).toEqual(['first', 'accepted']);
    }
  },
);

it('settles an idle incoming deadline after settings allocation without stranding future commands', async () => {
  const f = setup();
  await f.owner.enqueue('first');
  await f.owner.complete('first');
  f.store.admitOrdinaryLocalVertexContinuation(meta, binding, command('expired'));
  let release!: () => void;
  let waiting = false;
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.query.applySettings = vi.fn(async () => {
    waiting = true;
    await deferred;
  });
  const controller = new AbortController();
  const pending = f.owner.enqueue('expired', controller.signal);
  const observed = pending.then(
    () => 'accepted',
    () => 'refused',
  );
  await vi.waitFor(() => expect(waiting).toBe(true));
  expect(f.owner.activeCommandId()).toBe('expired');
  controller.abort(new Error('Incoming admission deadline'));
  release();
  expect(await observed).toBe('refused');
  expect(f.owner.activeCommandId()).toBeUndefined();
  expect(f.store.getSession('session')?.executionPhase).toBe('TERMINAL');
  expect(f.query.push.mock.calls.map(([id]) => id)).toEqual(['first']);
  expect(f.query.abort).not.toHaveBeenCalled();
  expect(f.store.getSendCommand('expired')?.error).toBe('Cancelled before SDK dispatch');
  expect(f.store.getOrdinaryLocalVertexCommandAdmission('expired')?.state).toBe('consumed');
  expect(
    f.store.getExecutionTerminalReason(f.store.getExecutionAdmission('session', 'expired')!.token),
  ).toBe('abandoned');
  f.store.admitOrdinaryLocalVertexContinuation(meta, binding, command('future'));
  await f.owner.enqueue('future');
  expect(f.query.push.mock.calls.map(([id]) => id)).toEqual(['first', 'future']);
  await f.owner.complete('future');
});

it('skips a consumed queued head cancelled during awaited authority and preserves its accepted tail', async () => {
  const f = setup();
  await f.owner.enqueue('first');
  for (const id of ['cancelled-head', 'accepted-tail']) {
    const model = id === 'cancelled-head' ? 'second' : 'third';
    f.store.admitOrdinaryLocalVertexContinuation(
      { ...meta, accountBinding: { ...meta.accountBinding, model } },
      binding,
      command(id, model),
    );
    await f.owner.enqueue(id);
    f.store.claimOrdinaryLocalVertexCommandDispatch(id);
    f.store.completeOrdinaryLocalVertexCommand(id);
  }
  let release!: () => void;
  let waiting = false;
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.assertCurrent.mockImplementationOnce(() => {});
  f.assertCurrent.mockImplementationOnce(async () => {
    waiting = true;
    await deferred;
  });
  const pending = f.owner.complete('first');
  const observed = pending.then(
    () => 'completed',
    () => 'refused',
  );
  await vi.waitFor(() => expect(waiting).toBe(true));
  expect(f.store.cancelOrdinaryLocalVertexQueuedCommand('session', 'cancelled-head')).toBe(
    'cancelled',
  );
  release();
  expect(await observed).toBe('completed');
  expect(f.store.getExecutionAdmission('session', 'cancelled-head')).toBeUndefined();
  expect(f.query.push.mock.calls.map(([id]) => id)).toEqual(['first', 'accepted-tail']);
  expect(f.query.push.mock.calls[1][1].selection).toEqual(
    command('accepted-tail', 'third').selection,
  );
  expect(f.store.getSendCommand('cancelled-head')?.error).toBe('Cancelled before SDK dispatch');
  expect(f.store.getOrdinaryLocalVertexCommandAdmission('cancelled-head')?.state).toBe('consumed');
  expect(f.query.abort).not.toHaveBeenCalled();
  await f.owner.complete('accepted-tail');
});

it.each([
  ['push', false],
  ['settings', true],
] as const)(
  'retains uncertainty after %s when input may be yielded or original authority is lost (%s)',
  async (phase, revoked) => {
    const f = setup();
    await f.owner.enqueue('first');
    await f.owner.complete('first');
    f.store.admitOrdinaryLocalVertexContinuation(meta, binding, command('expired'));
    let release!: () => void;
    let waiting = false;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (phase === 'settings')
      f.query.applySettings = vi.fn(async () => {
        waiting = true;
        await deferred;
      });
    else
      f.query.push.mockImplementationOnce(async () => {
        waiting = true;
        await deferred;
      });
    const controller = new AbortController();
    const pending = f.owner.enqueue('expired', controller.signal);
    const observed = pending.then(
      () => 'accepted',
      () => 'refused',
    );
    await vi.waitFor(() => expect(waiting).toBe(true));
    controller.abort(new Error('Incoming deadline'));
    if (revoked)
      f.assertCurrent.mockImplementation(() => {
        throw Error('Original ADC revoked');
      });
    release();
    expect(await observed).toBe('refused');
    expect(f.owner.activeCommandId()).toBe('expired');
    expect(f.store.getSession('session')?.executionPhase).toBe('RUNNING');
    expect(f.store.getOrdinaryLocalVertexCommandAdmission('expired')?.state).toBe('uncertain');
    expect(f.store.getSendCommand('expired')?.error).toBeNull();
    if (revoked) expect(f.query.abort).toHaveBeenCalledOnce();
    else expect(f.query.abort).not.toHaveBeenCalled();
  },
);

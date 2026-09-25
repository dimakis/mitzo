import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionRegistry,
  MAX_PENDING_EXECUTION_RETAINED_BYTES,
  MAX_PENDING_EXECUTIONS_RETAINED_BYTES,
  MAX_PENDING_EXECUTIONS_PER_SESSION,
  SessionRegistry,
  type PendingExecutionInput,
} from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import {
  broadcastStoredExecutionEvent,
  ExecutionController,
  PendingExecutionOverflowError,
} from '../execution-controller.js';
import type { SessionTransport } from '@mitzo/harness';

const CLIENT_ID = 'client-1';
const SESSION_ID = 'controller-session';

function fakeTransport(): SessionTransport & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    send(event: Record<string, unknown>) {
      sent.push(event);
    },
    isOpen() {
      return true;
    },
  };
}

function prepared(
  executionId: string,
  dispatch: PendingExecutionInput['dispatch'] = vi.fn(),
  options: Partial<
    Pick<PendingExecutionInput, 'clientMsgId' | 'requestFingerprint' | 'isInitial'>
  > = {},
): PendingExecutionInput {
  return {
    executionId,
    clientMsgId: options.clientMsgId ?? `message-${executionId}`,
    requestFingerprint: options.requestFingerprint ?? `fingerprint-${executionId}`,
    retainedBytes: 0,
    isInitial: options.isInitial ?? false,
    dispatch,
  };
}

describe('ExecutionController', () => {
  let store: EventStore;
  let registry: SessionRegistry;
  let connections: ConnectionRegistry;
  let controller: ExecutionController;
  let transport: ReturnType<typeof fakeTransport>;

  beforeEach(() => {
    store = new EventStore(':memory:');
    store.upsertSession({ sessionId: SESSION_ID });
    registry = new SessionRegistry();
    connections = new ConnectionRegistry();
    transport = fakeTransport();
    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: SESSION_ID,
    });
    controller = new ExecutionController({ registry, eventStore: store, connections });
  });

  afterEach(() => {
    registry.dispose();
    store.close();
  });

  it('runs pending executions FIFO across finish transitions', async () => {
    const order: string[] = [];
    controller.enqueueExecution(
      CLIENT_ID,
      prepared('one', () => {
        order.push('one');
      }),
    );
    controller.enqueueExecution(
      CLIENT_ID,
      prepared('two', () => {
        order.push('two');
      }),
    );
    controller.enqueueExecution(
      CLIENT_ID,
      prepared('three', () => {
        order.push('three');
      }),
    );

    const first = await controller.activateNextExecution(CLIENT_ID);
    const lease = registry.getRuntimeLease(CLIENT_ID)!;
    const second = await controller.finishExecution(lease, first!.token!, 'completed');
    const third = await controller.finishExecution(lease, second.next!.token!, 'completed');

    expect(order).toEqual(['one', 'two', 'three']);
    expect([
      first!.token!.generation,
      second.next!.token!.generation,
      third.next!.token!.generation,
    ]).toEqual([1, 2, 3]);
    expect(registry.get(CLIENT_ID)?.pendingExecutions).toEqual([]);
  });

  it('rejects work beyond the bounded queue before durable admission', () => {
    for (let index = 0; index < MAX_PENDING_EXECUTIONS_PER_SESSION; index++) {
      controller.enqueueExecution(CLIENT_ID, prepared(`queued-${index}`));
    }

    expect(() => controller.enqueueExecution(CLIENT_ID, prepared('overflow'))).toThrow(
      PendingExecutionOverflowError,
    );
    expect(registry.get(CLIENT_ID)?.pendingExecutions).toHaveLength(
      MAX_PENDING_EXECUTIONS_PER_SESSION,
    );
    expect(store.getSessionEvents(SESSION_ID)).toHaveLength(0);
  });

  it('serializes concurrent activators and dispatches the head once', async () => {
    let resolveDispatch!: () => void;
    const dispatch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDispatch = resolve;
        }),
    );
    controller.enqueueExecution(CLIENT_ID, prepared('one', dispatch));

    const first = controller.activateNextExecution(CLIENT_ID);
    const second = controller.activateNextExecution(CLIENT_ID);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(await second).toBeUndefined();

    resolveDispatch();
    expect((await first)?.token).toMatchObject({ executionId: 'one', generation: 1 });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('drops an exact duplicate admission without dispatching or allocating a generation', async () => {
    const original = store.beginExecution(SESSION_ID, 'duplicate', 'message-duplicate', 'fp');
    store.transitionExecution(original.token, 'TERMINAL', 'completed');
    const dispatch = vi.fn();
    controller.enqueueExecution(
      CLIENT_ID,
      prepared('duplicate', dispatch, {
        clientMsgId: 'message-duplicate',
        requestFingerprint: 'fp',
      }),
    );

    expect(await controller.activateNextExecution(CLIENT_ID)).toEqual({ failures: [] });
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.getSession(SESSION_ID)?.executionGeneration).toBe(1);
    expect(registry.get(CLIENT_ID)?.pendingExecutions).toEqual([]);
  });

  it('sets the current token before its dispatcher observes activation', async () => {
    let observed: unknown;
    controller.enqueueExecution(
      CLIENT_ID,
      prepared('visible-token', (token) => {
        observed = registry.get(CLIENT_ID)?.currentExecution;
        expect(observed).toEqual(token);
        expect(registry.get(CLIENT_ID)?.pendingExecutions).toEqual([]);
      }),
    );

    await controller.activateNextExecution(CLIENT_ID);
    expect(observed).toMatchObject({ executionId: 'visible-token', generation: 1 });
  });

  it('announces initial admission only after RUNNING is durable and before provider dispatch', async () => {
    const order: string[] = [];
    controller.enqueueExecution(CLIENT_ID, {
      ...prepared('initial', () => {
        order.push('dispatch');
        expect(registry.get(CLIENT_ID)?.currentExecution).toMatchObject({ executionId: 'initial' });
      }),
      isInitial: true,
      onAdmitted: (token) => {
        order.push('accepted');
        expect(registry.get(CLIENT_ID)?.currentExecution).toEqual(token);
        expect(store.getSessionEvents(SESSION_ID)).toMatchObject([
          { payload: { phase: 'RUNNING', executionId: 'initial' } },
        ]);
      },
    });

    await controller.activateNextExecution(CLIENT_ID);
    expect(order).toEqual(['accepted', 'dispatch']);
  });

  it('broadcasts the ordinary echo then RUNNING before admitting or dispatching', async () => {
    const order: string[] = [];
    controller.enqueueExecution(CLIENT_ID, {
      ...prepared('atomic-echo', () => {
        order.push('dispatch');
      }),
      clientMsgId: 'atomic-echo-message',
      requestFingerprint: 'atomic-echo-fingerprint',
      userMessage: { messageId: 'atomic-echo-message', text: 'atomic echo' },
      onAdmitted: () => {
        order.push('accepted');
      },
    });

    await controller.activateNextExecution(CLIENT_ID);

    expect(transport.sent.map((event) => event.phase ?? event.type)).toEqual([
      'user_message',
      'RUNNING',
    ]);
    expect(order).toEqual(['accepted', 'dispatch']);
    expect(store.getSessionEvents(SESSION_ID).map((event) => event.type)).toEqual([
      'user_message',
      'execution_state_changed',
    ]);
  });

  it('drops a rolled-back ordinary admission and advances the next FIFO item', async () => {
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    db.exec(`
      CREATE TRIGGER reject_ordinary_running
      BEFORE INSERT ON events
      WHEN NEW.type = 'execution_state_changed' AND NEW.payload LIKE '%reject-me%'
      BEGIN SELECT RAISE(ABORT, 'injected ordinary failure'); END;
    `);
    const rejected = vi.fn();
    const nextDispatch = vi.fn();
    controller.enqueueExecution(CLIENT_ID, {
      ...prepared('reject-me'),
      userMessage: { messageId: 'message-reject-me', text: 'reject me' },
      onRejected: rejected,
    });
    controller.enqueueExecution(CLIENT_ID, prepared('next-after-rollback', nextDispatch));

    const activation = await controller.activateNextExecution(CLIENT_ID);

    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'injected ordinary failure' }),
    );
    expect(nextDispatch).toHaveBeenCalledOnce();
    expect(activation).toMatchObject({
      failures: [{ executionId: 'reject-me' }],
      token: { executionId: 'next-after-rollback', generation: 1 },
    });
    expect(store.getSessionEvents(SESSION_ID).map((event) => event.payload.phase)).toEqual([
      'RUNNING',
    ]);
  });

  it('terminalizes a dispatch failure and advances to the next FIFO item', async () => {
    const order: string[] = [];
    controller.enqueueExecution(
      CLIENT_ID,
      prepared(
        'broken',
        () => {
          order.push('broken');
          throw new Error('startup failed');
        },
        { isInitial: true },
      ),
    );
    controller.enqueueExecution(
      CLIENT_ID,
      prepared('next', () => {
        order.push('next');
      }),
    );

    const activated = await controller.activateNextExecution(CLIENT_ID);

    expect(order).toEqual(['broken', 'next']);
    expect(activated?.token).toMatchObject({ executionId: 'next', generation: 2 });
    expect(store.getSessionEvents(SESSION_ID).map((event) => event.payload.phase)).toEqual([
      'RUNNING',
      'TERMINAL',
      'RUNNING',
    ]);
    expect(store.getSession(SESSION_ID)?.executionTerminalReason).toBeNull();
    expect(activated?.failures).toHaveLength(1);
    expect(activated?.failures[0]).toMatchObject({
      executionId: 'broken',
      clientMsgId: 'message-broken',
      requestFingerprint: 'fingerprint-broken',
    });
  });

  it('does not let a stale dispatch failure clear a replacement current token', async () => {
    let rejectDispatch!: (error: Error) => void;
    controller.enqueueExecution(
      CLIENT_ID,
      prepared(
        'first',
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectDispatch = reject;
          }),
      ),
    );
    controller.enqueueExecution(CLIENT_ID, prepared('third'));
    const activation = controller.activateNextExecution(CLIENT_ID);
    const firstToken = registry.get(CLIENT_ID)!.currentExecution!;
    store.transitionExecution(firstToken, 'TERMINAL', 'completed');
    const replacement = store.beginExecution(
      SESSION_ID,
      'replacement',
      'message-replacement',
      'fp-replacement',
    );
    // Simulate a replacement that became current while the original provider
    // promise was still unwinding. The old failure must not clear this token.
    registry.get(CLIENT_ID)!.currentExecution = replacement.token;

    rejectDispatch(new Error('late provider failure'));
    const result = await activation;

    expect(registry.get(CLIENT_ID)?.currentExecution).toEqual(replacement.token);
    expect(registry.get(CLIENT_ID)?.pendingExecutions.map((item) => item.executionId)).toEqual([
      'third',
    ]);
    expect(result).toMatchObject({ stale: true, failures: [{ executionId: 'first' }] });
  });

  it('does not emit or clear on a stale finish, but finishes current work and activates next', async () => {
    controller.enqueueExecution(CLIENT_ID, prepared('first'));
    controller.enqueueExecution(CLIENT_ID, prepared('next'));
    const first = await controller.activateNextExecution(CLIENT_ID);
    const stale = { ...first!.token!, generation: 99 };
    const before = store.getSessionEvents(SESSION_ID).length;

    const lease = registry.getRuntimeLease(CLIENT_ID)!;
    const staleResult = await controller.finishExecution(lease, stale, 'failed');
    expect(staleResult.stale).toBe(true);
    expect(store.getSessionEvents(SESSION_ID)).toHaveLength(before);
    expect(registry.get(CLIENT_ID)?.currentExecution).toEqual(first!.token);

    const finished = await controller.finishExecution(lease, first!.token!, 'completed');
    expect(finished.transition?.applied).toBe(true);
    expect(finished.next?.token).toMatchObject({ executionId: 'next', generation: 2 });
  });

  it('broadcasts durable replacement rows before terminalizing an undispatchable admission', async () => {
    controller.enqueueExecution(CLIENT_ID, prepared('initial'));
    const initial = await controller.activateNextExecution(CLIENT_ID);
    const lease = registry.getRuntimeLease(CLIENT_ID)!;
    const dispatch = vi.fn();
    const before = transport.sent.length;

    const replacement = await controller.replaceExecution(lease, {
      expectedToken: initial!.token!,
      executionId: 'replacement-owner-stale',
      clientMsgId: 'replacement-owner-stale-message',
      requestFingerprint: 'replacement-owner-stale-fingerprint',
      retainedBytes: 0,
      userMessage: { messageId: 'replacement-owner-stale-message', text: 'replace' },
      beforeDispatch: () => false,
      dispatch,
    });

    expect(replacement).toMatchObject({ stale: true, notDispatched: true });
    expect(dispatch).not.toHaveBeenCalled();
    expect(registry.get(CLIENT_ID)?.currentExecution).toBeUndefined();
    expect(transport.sent).toHaveLength(before + 4);
    expect(transport.sent.slice(before).map((event) => event.phase ?? event.type)).toEqual([
      'TERMINAL',
      'user_message',
      'RUNNING',
      'TERMINAL',
    ]);
    expect(store.getSession(SESSION_ID)).toMatchObject({
      executionPhase: 'TERMINAL',
      executionGeneration: 2,
      executionTerminalReason: 'failed',
    });
  });

  it('envelopes replacement rows and delivers them once to both a watcher and runtime driver', async () => {
    const watcher = fakeTransport();
    connections.register('replacement-watcher', watcher);
    connections.watch('replacement-watcher', SESSION_ID);
    controller.enqueueExecution(CLIENT_ID, prepared('initial'));
    const initial = await controller.activateNextExecution(CLIENT_ID);
    const lease = registry.getRuntimeLease(CLIENT_ID)!;
    const driverBefore = transport.sent.length;
    const watcherBefore = watcher.sent.length;

    await controller.replaceExecution(lease, {
      expectedToken: initial!.token!,
      executionId: 'replacement-delivery',
      clientMsgId: 'replacement-delivery-message',
      requestFingerprint: 'replacement-delivery-fingerprint',
      retainedBytes: 0,
      userMessage: { messageId: 'replacement-delivery-message', text: 'replace' },
      dispatch: vi.fn(),
    });

    const expectedPhases = ['TERMINAL', 'user_message', 'RUNNING'];
    const driverRows = transport.sent.slice(driverBefore);
    const watcherRows = watcher.sent.slice(watcherBefore);
    expect(driverRows.map((event) => event.phase ?? event.type)).toEqual(expectedPhases);
    expect(watcherRows.map((event) => event.phase ?? event.type)).toEqual(expectedPhases);
    expect(driverRows).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: SESSION_ID })]),
    );
    expect(watcherRows).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: SESSION_ID })]),
    );
  });

  it('releases its owner reservation when a concurrent replacement is busy', async () => {
    controller.enqueueExecution(CLIENT_ID, prepared('initial'));
    const initial = await controller.activateNextExecution(CLIENT_ID);
    const lease = registry.getRuntimeLease(CLIENT_ID)!;
    const owner = registry.getRuntimeOwnerSnapshot(lease)!;
    let releaseHook!: (allowed: boolean) => void;
    const first = controller.replaceExecution(lease, {
      expectedToken: initial!.token!,
      executionId: 'replacement-a',
      clientMsgId: 'replacement-a-message',
      requestFingerprint: 'replacement-a-fingerprint',
      retainedBytes: 0,
      userMessage: { messageId: 'replacement-a-message', text: 'A' },
      reserveOwner: () => registry.reserveRuntimeOwner(owner, owner.ownerConnectionId, transport),
      releaseOwner: (reservation) => registry.releaseRuntimeOwnerReservation(reservation as never),
      commitOwner: (reservation) => registry.commitReservedRuntimeOwner(reservation as never),
      beforeDispatch: () =>
        new Promise<boolean>((resolve) => {
          releaseHook = resolve;
        }),
      dispatch: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(registry.get(CLIENT_ID)?.currentExecution?.executionId).toBe('replacement-a'),
    );

    const busy = await controller.replaceExecution(lease, {
      expectedToken: initial!.token!,
      clientMsgId: 'replacement-b-message',
      requestFingerprint: 'replacement-b-fingerprint',
      retainedBytes: 0,
      userMessage: { messageId: 'replacement-b-message', text: 'B' },
      reserveOwner: vi.fn(),
      dispatch: vi.fn(),
    });
    expect(busy).toEqual({ busy: true });

    releaseHook(true);
    await expect(first).resolves.toMatchObject({ admission: { duplicate: false } });
    expect(registry.get(CLIENT_ID)?.ownerReservation).toBeUndefined();
    expect(registry.rekey(CLIENT_ID, 'client-after-reservation')).toBe(true);
  });

  it('keeps a durable replacement accepted when stop wins during a dispatch hook', async () => {
    controller.enqueueExecution(CLIENT_ID, prepared('initial'));
    const initial = await controller.activateNextExecution(CLIENT_ID);
    const lease = registry.getRuntimeLease(CLIENT_ID)!;
    let releaseHook!: (allowed: boolean) => void;
    const replacement = controller.replaceExecution(lease, {
      expectedToken: initial!.token!,
      executionId: 'replacement-stop-hook',
      clientMsgId: 'replacement-stop-hook-message',
      requestFingerprint: 'replacement-stop-hook-fingerprint',
      retainedBytes: 0,
      userMessage: { messageId: 'replacement-stop-hook-message', text: 'replace' },
      beforeDispatch: () =>
        new Promise<boolean>((resolve) => {
          releaseHook = resolve;
        }),
      dispatch: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(registry.get(CLIENT_ID)?.currentExecution?.executionId).toBe('replacement-stop-hook'),
    );
    const token = registry.get(CLIENT_ID)!.currentExecution!;
    await controller.stopExecution(lease, token);
    releaseHook(true);

    await expect(replacement).resolves.toMatchObject({
      token,
      admission: { duplicate: false },
      stale: true,
      notDispatched: true,
    });
    expect(
      store.getSessionEvents(SESSION_ID).map((event) => event.payload.phase ?? event.payload.type),
    ).toEqual(['RUNNING', 'TERMINAL', 'user_message', 'RUNNING', 'TERMINAL']);
    expect(store.getSessionEvents(SESSION_ID).at(-1)?.payload.terminalReason).toBe('stopped');
  });

  it('rejects an oversized replacement before durable admission or provider dispatch', async () => {
    controller.enqueueExecution(CLIENT_ID, prepared('initial'));
    const initial = await controller.activateNextExecution(CLIENT_ID);
    const lease = registry.getRuntimeLease(CLIENT_ID)!;
    const dispatch = vi.fn();
    const before = store.getSessionEvents(SESSION_ID);

    const replacement = await controller.replaceExecution(lease, {
      expectedToken: initial!.token!,
      clientMsgId: 'replacement-too-large',
      requestFingerprint: 'replacement-too-large-fingerprint',
      retainedBytes: MAX_PENDING_EXECUTION_RETAINED_BYTES + 1,
      userMessage: { messageId: 'replacement-too-large', text: 'replace' },
      dispatch,
    });

    expect(replacement.error).toBeInstanceOf(PendingExecutionOverflowError);
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.getSessionEvents(SESSION_ID)).toEqual(before);
    expect(registry.get(CLIENT_ID)?.currentExecution).toEqual(initial!.token);
  });

  it('stops only the replacement token once after an interrupted predecessor', async () => {
    controller.enqueueExecution(CLIENT_ID, prepared('initial'));
    const initial = await controller.activateNextExecution(CLIENT_ID);
    const lease = registry.getRuntimeLease(CLIENT_ID)!;
    const replacement = await controller.replaceExecution(lease, {
      expectedToken: initial!.token!,
      executionId: 'replacement-stop',
      clientMsgId: 'replacement-stop-message',
      requestFingerprint: 'replacement-stop-fingerprint',
      retainedBytes: 0,
      userMessage: { messageId: 'replacement-stop-message', text: 'replace' },
      dispatch: vi.fn(),
    });

    expect(
      registry.claimReplacementInputBarrier(lease, replacement.token!, 7, 60_000, vi.fn()),
    ).toBe(true);

    const stopped = await controller.stopExecution(lease, replacement.token!);
    const repeated = await controller.stopExecution(lease, replacement.token!);
    const terminals = store
      .getSessionEvents(SESSION_ID)
      .filter((event) => event.payload.phase === 'TERMINAL');

    expect(stopped.transition).toMatchObject({
      applied: true,
      event: { terminalReason: 'stopped' },
    });
    expect(repeated.stale).toBe(true);
    expect(terminals.map((event) => event.payload.terminalReason)).toEqual([
      'interrupted',
      'stopped',
    ]);
    expect(registry.get(CLIENT_ID)?.currentExecution).toBeUndefined();
    expect(registry.get(CLIENT_ID)).toMatchObject({
      replacementInputCount: 0,
      replacementInputBytes: 0,
      replacementInputBarrier: undefined,
    });
  });

  it('releases a consumed replacement envelope when its normal terminal result finishes', async () => {
    controller.enqueueExecution(CLIENT_ID, prepared('initial'));
    const initial = await controller.activateNextExecution(CLIENT_ID);
    const lease = registry.getRuntimeLease(CLIENT_ID)!;
    const replacement = await controller.replaceExecution(lease, {
      expectedToken: initial!.token!,
      executionId: 'replacement-result',
      clientMsgId: 'replacement-result-message',
      requestFingerprint: 'replacement-result-fingerprint',
      retainedBytes: 0,
      userMessage: { messageId: 'replacement-result-message', text: 'replace' },
      dispatch: vi.fn(),
    });
    expect(
      registry.claimReplacementInputBarrier(lease, replacement.token!, 11, 60_000, vi.fn()),
    ).toBe(true);

    await expect(
      controller.finishExecution(lease, replacement.token!, 'completed'),
    ).resolves.toMatchObject({
      transition: { applied: true },
    });
    expect(registry.get(CLIENT_ID)).toMatchObject({
      replacementInputCount: 0,
      replacementInputBytes: 0,
      replacementInputBarrier: undefined,
    });
  });

  it('returns an older durable replacement receipt after a newer replacement is current', async () => {
    controller.enqueueExecution(CLIENT_ID, prepared('initial'));
    const initial = await controller.activateNextExecution(CLIENT_ID);
    const lease = registry.getRuntimeLease(CLIENT_ID)!;
    const dispatchA = vi.fn();
    const a = await controller.replaceExecution(lease, {
      expectedToken: initial!.token!,
      executionId: 'replacement-a',
      clientMsgId: 'replacement-a-message',
      requestFingerprint: 'replacement-a-fingerprint',
      retainedBytes: 0,
      userMessage: { messageId: 'replacement-a-message', text: 'A' },
      dispatch: dispatchA,
    });
    const b = await controller.replaceExecution(lease, {
      expectedToken: a.token!,
      executionId: 'replacement-b',
      clientMsgId: 'replacement-b-message',
      requestFingerprint: 'replacement-b-fingerprint',
      retainedBytes: 0,
      userMessage: { messageId: 'replacement-b-message', text: 'B' },
      dispatch: vi.fn(),
    });
    const retryDispatch = vi.fn();

    const retry = await controller.replaceExecution(lease, {
      expectedToken: initial!.token!,
      executionId: 'replacement-a',
      clientMsgId: 'replacement-a-message',
      requestFingerprint: 'replacement-a-fingerprint',
      retainedBytes: 0,
      userMessage: { messageId: 'replacement-a-message', text: 'A' },
      dispatch: retryDispatch,
    });

    expect(retry.admission?.duplicate).toBe(true);
    expect(retry.token).toEqual(a.token);
    expect(retryDispatch).not.toHaveBeenCalled();
    expect(registry.get(CLIENT_ID)?.currentExecution).toEqual(b.token);
  });

  it('stops only the current token and drains pending work without activating a successor', async () => {
    const dispatchNext = vi.fn();
    controller.enqueueExecution(CLIENT_ID, prepared('current'));
    controller.enqueueExecution(CLIENT_ID, prepared('queued', dispatchNext));
    const current = await controller.activateNextExecution(CLIENT_ID);
    const lease = registry.getRuntimeLease(CLIENT_ID)!;

    const stopped = await controller.stopExecution(lease, current!.token!);

    expect(stopped.transition).toMatchObject({ applied: true });
    expect(stopped.failures?.map((failure) => failure.executionId)).toEqual(['queued']);
    expect(dispatchNext).not.toHaveBeenCalled();
    expect(registry.get(CLIENT_ID)?.currentExecution).toBeUndefined();
    expect(registry.get(CLIENT_ID)?.pendingExecutions).toEqual([]);
    expect(store.getSession(SESSION_ID)?.executionTerminalReason).toBe('stopped');
    expect(store.getSessionEvents(SESSION_ID).map((event) => event.payload.phase)).toEqual([
      'RUNNING',
      'TERMINAL',
    ]);
  });

  it('preserves execution controller state across detach and reattach', async () => {
    controller.enqueueExecution(CLIENT_ID, prepared('current'));
    controller.enqueueExecution(CLIENT_ID, prepared('pending'));
    const current = await controller.activateNextExecution(CLIENT_ID);
    const replacementTransport = fakeTransport();

    registry.detach(CLIENT_ID);
    registry.reattach(CLIENT_ID, replacementTransport);

    expect(registry.get(CLIENT_ID)?.currentExecution).toEqual(current!.token);
    expect(registry.get(CLIENT_ID)?.pendingExecutions.map((item) => item.executionId)).toEqual([
      'pending',
    ]);
  });

  it('drains pending work deterministically without allocating generations', () => {
    controller.enqueueExecution(CLIENT_ID, prepared('first'));
    controller.enqueueExecution(CLIENT_ID, prepared('second'));

    const failures = controller.failPendingExecutions(CLIENT_ID, 'runtime removed');

    expect(failures.map((failure) => failure.executionId)).toEqual(['first', 'second']);
    expect(failures.map((failure) => failure.error)).toEqual([
      new Error('runtime removed'),
      new Error('runtime removed'),
    ]);
    expect(registry.get(CLIENT_ID)?.pendingExecutions).toEqual([]);
    expect(store.getSessionEvents(SESSION_ID)).toHaveLength(0);
    expect(registry.get(CLIENT_ID)?.pendingExecutionBytes).toBe(0);
  });

  it('uses explicit per-item and aggregate retained-byte budgets', () => {
    controller.enqueueExecution(CLIENT_ID, { ...prepared('zero'), retainedBytes: 0 });
    controller.enqueueExecution(CLIENT_ID, {
      ...prepared('at-limit'),
      retainedBytes: MAX_PENDING_EXECUTION_RETAINED_BYTES,
    });
    expect(() =>
      controller.enqueueExecution(CLIENT_ID, {
        ...prepared('too-large'),
        retainedBytes: MAX_PENDING_EXECUTION_RETAINED_BYTES + 1,
      }),
    ).toThrow(PendingExecutionOverflowError);
    expect(() =>
      controller.enqueueExecution(CLIENT_ID, {
        ...prepared('aggregate-over'),
        retainedBytes: MAX_PENDING_EXECUTION_RETAINED_BYTES + 1,
      }),
    ).toThrow(PendingExecutionOverflowError);
    expect(registry.get(CLIENT_ID)?.pendingExecutionBytes).toBe(
      MAX_PENDING_EXECUTION_RETAINED_BYTES,
    );

    // A fresh runtime demonstrates aggregate rejection independently of item cap.
    registry.remove(CLIENT_ID);
    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: SESSION_ID,
    });
    controller.enqueueExecution(CLIENT_ID, {
      ...prepared('one'),
      retainedBytes: MAX_PENDING_EXECUTION_RETAINED_BYTES,
    });
    controller.enqueueExecution(CLIENT_ID, {
      ...prepared('two'),
      retainedBytes: MAX_PENDING_EXECUTION_RETAINED_BYTES,
    });
    expect(registry.get(CLIENT_ID)?.pendingExecutionBytes).toBe(
      MAX_PENDING_EXECUTIONS_RETAINED_BYTES,
    );
    expect(() =>
      controller.enqueueExecution(CLIENT_ID, { ...prepared('three'), retainedBytes: 1 }),
    ).toThrow(PendingExecutionOverflowError);
  });

  it('keeps its lease through rekey and activates the next FIFO item after completion', async () => {
    let resolveDispatch!: () => void;
    controller.enqueueExecution(
      CLIENT_ID,
      prepared(
        'one',
        () =>
          new Promise<void>((resolve) => {
            resolveDispatch = resolve;
          }),
      ),
    );
    controller.enqueueExecution(CLIENT_ID, prepared('two'));
    const activation = controller.activateNextExecution(CLIENT_ID);
    const token = registry.get(CLIENT_ID)!.currentExecution!;
    const lease = registry.getRuntimeLease(CLIENT_ID)!;
    const observer = fakeTransport();
    registry.addObserver(SESSION_ID, observer);
    expect(registry.rekey(CLIENT_ID, 'client-rekeyed')).toBe(true);
    resolveDispatch();
    expect((await activation)?.token).toEqual(token);
    const finished = await controller.finishExecution(lease, token, 'completed');
    expect(finished.next?.token).toMatchObject({ executionId: 'two', generation: 2 });
    expect(registry.get('client-rekeyed')?.observers).toContain(observer);
  });

  it('does not terminalize or clear a same-session ABA replacement on a late finish', async () => {
    controller.enqueueExecution(CLIENT_ID, prepared('original'));
    const activated = await controller.activateNextExecution(CLIENT_ID);
    const originalLease = registry.getRuntimeLease(CLIENT_ID)!;
    store.transitionExecution(activated!.token!, 'TERMINAL', 'completed');
    registry.remove(CLIENT_ID);
    const replacementTransport = fakeTransport();
    registry.register(CLIENT_ID, {
      transport: replacementTransport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: SESSION_ID,
    });
    const replacement = store.beginExecution(SESSION_ID, 'replacement-finish', 'message-r', 'fp-r');
    registry.get(CLIENT_ID)!.currentExecution = replacement.token;
    const before = store.getSessionEvents(SESSION_ID).length;

    expect(await controller.finishExecution(originalLease, activated!.token!, 'completed')).toEqual(
      {
        stale: true,
      },
    );
    expect(store.getSessionEvents(SESSION_ID)).toHaveLength(before);
    expect(registry.get(CLIENT_ID)?.currentExecution).toEqual(replacement.token);
    expect(replacementTransport.sent).toEqual([]);
  });

  it('cannot let an ABA late failure affect a replacement runtime', async () => {
    let rejectDispatch!: (error: Error) => void;
    controller.enqueueExecution(
      CLIENT_ID,
      prepared(
        'old',
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectDispatch = reject;
          }),
      ),
    );
    const oldActivation = controller.activateNextExecution(CLIENT_ID);
    registry.remove(CLIENT_ID);
    const replacementTransport = fakeTransport();
    registry.register(CLIENT_ID, {
      transport: replacementTransport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: SESSION_ID,
    });
    controller.enqueueExecution(CLIENT_ID, prepared('replacement'));
    rejectDispatch(new Error('old runtime failed'));
    expect(await oldActivation).toMatchObject({ stale: true, failures: [{ executionId: 'old' }] });
    expect(registry.get(CLIENT_ID)?.currentExecution).toBeUndefined();
    expect(registry.get(CLIENT_ID)?.pendingExecutions.map((item) => item.executionId)).toEqual([
      'replacement',
    ]);
    expect(replacementTransport.sent).toEqual([]);
    expect(store.getSessionEvents(SESSION_ID).map((item) => item.payload.phase)).toEqual([
      'RUNNING',
    ]);
  });

  it('returns stale for an ABA late dispatch success without touching the replacement', async () => {
    let resolveDispatch!: () => void;
    controller.enqueueExecution(
      CLIENT_ID,
      prepared(
        'old-success',
        () =>
          new Promise<void>((resolve) => {
            resolveDispatch = resolve;
          }),
      ),
    );
    const oldActivation = controller.activateNextExecution(CLIENT_ID);
    registry.remove(CLIENT_ID);
    const replacementTransport = fakeTransport();
    registry.register(CLIENT_ID, {
      transport: replacementTransport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: SESSION_ID,
    });
    controller.enqueueExecution(CLIENT_ID, prepared('replacement-success'));
    resolveDispatch();
    expect(await oldActivation).toEqual({ failures: [], stale: true });
    expect(registry.get(CLIENT_ID)?.currentExecution).toBeUndefined();
    expect(registry.get(CLIENT_ID)?.pendingExecutions.map((item) => item.executionId)).toEqual([
      'replacement-success',
    ]);
    expect(replacementTransport.sent).toEqual([]);
  });
});

describe('broadcastStoredExecutionEvent', () => {
  it('delivers the existing durable seq once without appending another event', () => {
    const store = new EventStore(':memory:');
    const registry = new SessionRegistry();
    const connections = new ConnectionRegistry();
    const transport = fakeTransport();
    store.upsertSession({ sessionId: SESSION_ID });
    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: SESSION_ID,
    });
    connections.register('connection-1', transport);
    connections.watch('connection-1', SESSION_ID);
    const begun = store.beginExecution(SESSION_ID, 'event', 'message-event', 'fingerprint-event');

    broadcastStoredExecutionEvent(
      registry.getRuntimeLease(CLIENT_ID)!,
      { seq: begun.seq!, event: begun.event! },
      registry,
      connections,
    );

    expect(store.getSessionEvents(SESSION_ID)).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      type: begun.event!.type,
      seq: begun.seq,
      executionId: 'event',
    });
    registry.dispose();
    store.close();
  });

  it('does not append or live-send for a detached driver and later replays once', () => {
    const store = new EventStore(':memory:');
    const registry = new SessionRegistry();
    const transport = fakeTransport();
    store.upsertSession({ sessionId: SESSION_ID });
    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: SESSION_ID,
    });
    const begun = store.beginExecution(
      SESSION_ID,
      'offline',
      'message-offline',
      'fingerprint-offline',
    );
    registry.detach(CLIENT_ID);

    broadcastStoredExecutionEvent(
      registry.getRuntimeLease(CLIENT_ID)!,
      { seq: begun.seq!, event: begun.event! },
      registry,
    );

    expect(transport.sent).toEqual([]);
    const replay = store.getEventsAfter(SESSION_ID, 0);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ seq: begun.seq, payload: begun.event });
    registry.dispose();
    store.close();
  });

  it('fans an exact event to watcher, driver, and observer once each', () => {
    const store = new EventStore(':memory:');
    const registry = new SessionRegistry();
    const connections = new ConnectionRegistry();
    const driver = fakeTransport();
    const watcher = fakeTransport();
    const observer = fakeTransport();
    store.upsertSession({ sessionId: SESSION_ID });
    registry.register(CLIENT_ID, {
      transport: driver,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: SESSION_ID,
    });
    registry.addObserver(SESSION_ID, observer);
    connections.register('watcher', watcher);
    connections.watch('watcher', SESSION_ID);
    const begun = store.beginExecution(SESSION_ID, 'mixed', 'message-mixed', 'fp-mixed');
    const sent = broadcastStoredExecutionEvent(
      registry.getRuntimeLease(CLIENT_ID)!,
      { seq: begun.seq!, event: begun.event! },
      registry,
      connections,
    );
    expect(sent).toEqual(new Set([watcher, driver, observer]));
    for (const item of [watcher, driver, observer])
      expect(item.sent[0]).toMatchObject({ seq: begun.seq, type: begun.event!.type });
    expect(store.getSessionEvents(SESSION_ID)).toHaveLength(1);
    registry.dispose();
    store.close();
  });

  it('deduplicates a shared transport and rejects a stale lease or mismatched session', () => {
    const store = new EventStore(':memory:');
    const registry = new SessionRegistry();
    const connections = new ConnectionRegistry();
    const shared = fakeTransport();
    store.upsertSession({ sessionId: SESSION_ID });
    registry.register(CLIENT_ID, {
      transport: shared,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: SESSION_ID,
    });
    registry.addObserver(SESSION_ID, shared);
    connections.register('shared-watcher', shared);
    connections.watch('shared-watcher', SESSION_ID);
    const lease = registry.getRuntimeLease(CLIENT_ID)!;
    const begun = store.beginExecution(SESSION_ID, 'dedup', 'message-dedup', 'fp-dedup');
    broadcastStoredExecutionEvent(
      lease,
      { seq: begun.seq!, event: begun.event! },
      registry,
      connections,
    );
    expect(shared.sent).toHaveLength(1);
    broadcastStoredExecutionEvent(
      lease,
      { seq: begun.seq!, event: { ...begun.event!, sessionId: 'wrong' } },
      registry,
      connections,
    );
    registry.remove(CLIENT_ID);
    broadcastStoredExecutionEvent(
      lease,
      { seq: begun.seq!, event: begun.event! },
      registry,
      connections,
    );
    expect(shared.sent).toHaveLength(1);
    registry.dispose();
    store.close();
  });

  it('does not let a closed watcher suppress driver or observer delivery', () => {
    const store = new EventStore(':memory:');
    const registry = new SessionRegistry();
    const connections = new ConnectionRegistry();
    const driver = fakeTransport();
    const observer = fakeTransport();
    const closed: SessionTransport = { send: vi.fn(), isOpen: () => false };
    store.upsertSession({ sessionId: SESSION_ID });
    registry.register(CLIENT_ID, {
      transport: driver,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: SESSION_ID,
    });
    registry.addObserver(SESSION_ID, observer);
    connections.register('closed', closed);
    connections.watch('closed', SESSION_ID);
    const begun = store.beginExecution(SESSION_ID, 'closed', 'message-closed', 'fp-closed');
    broadcastStoredExecutionEvent(
      registry.getRuntimeLease(CLIENT_ID)!,
      { seq: begun.seq!, event: begun.event! },
      registry,
      connections,
    );
    expect(driver.sent).toHaveLength(1);
    expect(observer.sent).toHaveLength(1);
    expect(closed.send).not.toHaveBeenCalled();
    registry.dispose();
    store.close();
  });

  it('buffers once for a suspended driver while watcher and observer remain live', () => {
    const store = new EventStore(':memory:');
    const registry = new SessionRegistry();
    const connections = new ConnectionRegistry();
    const driver = fakeTransport();
    const watcher = fakeTransport();
    const observer = fakeTransport();
    store.upsertSession({ sessionId: SESSION_ID });
    registry.register(CLIENT_ID, {
      transport: driver,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: SESSION_ID,
    });
    registry.addObserver(SESSION_ID, observer);
    connections.register('watcher', watcher);
    connections.watch('watcher', SESSION_ID);
    registry.suspend(CLIENT_ID, 0);
    const begun = store.beginExecution(
      SESSION_ID,
      'suspended',
      'message-suspended',
      'fp-suspended',
    );
    broadcastStoredExecutionEvent(
      registry.getRuntimeLease(CLIENT_ID)!,
      { seq: begun.seq!, event: begun.event! },
      registry,
      connections,
    );
    expect(driver.sent).toEqual([]);
    expect(watcher.sent).toHaveLength(1);
    expect(observer.sent).toHaveLength(1);
    const replay = registry.resume(CLIENT_ID);
    expect(replay).toHaveLength(1);
    for (const event of replay) driver.send(event);
    expect(driver.sent).toHaveLength(1);
    expect(watcher.sent).toHaveLength(1);
    expect(observer.sent).toHaveLength(1);
    registry.dispose();
    store.close();
  });

  it('excludes a suspended owner that is also a watcher from live fan-out', () => {
    const store = new EventStore(':memory:');
    const registry = new SessionRegistry();
    const connections = new ConnectionRegistry();
    const driver = fakeTransport();
    const watcher = fakeTransport();
    const observer = fakeTransport();
    store.upsertSession({ sessionId: SESSION_ID });
    registry.register(CLIENT_ID, {
      transport: driver,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: SESSION_ID,
    });
    registry.addObserver(SESSION_ID, driver);
    registry.addObserver(SESSION_ID, observer);
    connections.register('owner', driver);
    connections.watch('owner', SESSION_ID);
    connections.register('distinct', watcher);
    connections.watch('distinct', SESSION_ID);
    registry.suspend(CLIENT_ID, 0);
    const begun = store.beginExecution(SESSION_ID, 'owner-suspended', 'message-owner', 'fp-owner');
    broadcastStoredExecutionEvent(
      registry.getRuntimeLease(CLIENT_ID)!,
      { seq: begun.seq!, event: begun.event! },
      registry,
      connections,
    );
    expect(driver.sent).toEqual([]);
    expect(connections.getCursor('owner', SESSION_ID)).toBeUndefined();
    expect(watcher.sent).toHaveLength(1);
    expect(observer.sent).toHaveLength(1);
    const replay = registry.resume(CLIENT_ID);
    expect(replay).toHaveLength(1);
    driver.send(replay[0]);
    expect(driver.sent).toHaveLength(1);
    expect(watcher.sent).toHaveLength(1);
    expect(observer.sent).toHaveLength(1);
    registry.dispose();
    store.close();
  });

  it('advances only a same-transport watcher cursor after fallback delivery', () => {
    const store = new EventStore(':memory:');
    const registry = new SessionRegistry();
    const connections = new ConnectionRegistry();
    const sent: Record<string, unknown>[] = [];
    let attempts = 0;
    const shared: SessionTransport = {
      send(event) {
        attempts += 1;
        if (attempts === 1) throw new Error('transient watcher failure');
        sent.push(event);
      },
      isOpen: () => true,
    };
    store.upsertSession({ sessionId: SESSION_ID });
    registry.register(CLIENT_ID, {
      transport: shared,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: SESSION_ID,
    });
    connections.register('shared-watcher', shared);
    connections.watch('shared-watcher', SESSION_ID);
    const begun = store.beginExecution(SESSION_ID, 'cursor', 'message-cursor', 'fp-cursor');
    broadcastStoredExecutionEvent(
      registry.getRuntimeLease(CLIENT_ID)!,
      { seq: begun.seq!, event: begun.event! },
      registry,
      connections,
    );
    expect(sent).toHaveLength(1);
    expect(connections.getCursor('shared-watcher', SESSION_ID)).toBe(begun.seq);

    const other = fakeTransport();
    connections.recordFallbackDelivery(SESSION_ID, other, begun.seq! + 1);
    connections.recordFallbackDelivery(SESSION_ID, shared, begun.seq! + 2);
    expect(connections.getCursor('shared-watcher', SESSION_ID)).toBe(begun.seq! + 2);
    registry.dispose();
    store.close();
  });

  it('leaves watcher cursors unchanged when every physical send fails', () => {
    const store = new EventStore(':memory:');
    const registry = new SessionRegistry();
    const connections = new ConnectionRegistry();
    const broken: SessionTransport = {
      send: () => {
        throw new Error('broken');
      },
      isOpen: () => true,
    };
    store.upsertSession({ sessionId: SESSION_ID });
    registry.register(CLIENT_ID, {
      transport: broken,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: SESSION_ID,
    });
    connections.register('broken-watcher', broken);
    connections.watch('broken-watcher', SESSION_ID);
    const begun = store.beginExecution(
      SESSION_ID,
      'broken-cursor',
      'message-broken-cursor',
      'fp-broken-cursor',
    );
    broadcastStoredExecutionEvent(
      registry.getRuntimeLease(CLIENT_ID)!,
      { seq: begun.seq!, event: begun.event! },
      registry,
      connections,
    );
    expect(connections.getCursor('broken-watcher', SESSION_ID)).toBeUndefined();
    registry.dispose();
    store.close();
  });
});

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
      prepared('one', () => order.push('one')),
    );
    controller.enqueueExecution(
      CLIENT_ID,
      prepared('two', () => order.push('two')),
    );
    controller.enqueueExecution(
      CLIENT_ID,
      prepared('three', () => order.push('three')),
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
      prepared('next', () => order.push('next')),
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
    expect(finished.transition.applied).toBe(true);
    expect(finished.next?.token).toMatchObject({ executionId: 'next', generation: 2 });
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
    expect(failures.map((failure) => failure.error.message)).toEqual([
      'runtime removed',
      'runtime removed',
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
    expect(connections.getCursor('shared-watcher', SESSION_ID)).toBe(begun.seq);
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

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionRegistry, SessionRegistry, type PendingExecutionInput } from '@mitzo/harness';
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
    providerPayload: { opaque: executionId },
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
    const second = await controller.finishExecution(CLIENT_ID, first!.token!, 'completed');
    const third = await controller.finishExecution(CLIENT_ID, second.next!.token!, 'completed');

    expect(order).toEqual(['one', 'two', 'three']);
    expect([
      first!.token!.generation,
      second.next!.token!.generation,
      third.next!.token!.generation,
    ]).toEqual([1, 2, 3]);
    expect(registry.get(CLIENT_ID)?.pendingExecutions).toEqual([]);
  });

  it('rejects the 101st pending execution before durable admission', () => {
    for (let index = 0; index < 100; index++) {
      controller.enqueueExecution(CLIENT_ID, prepared(`queued-${index}`));
    }

    expect(() => controller.enqueueExecution(CLIENT_ID, prepared('queued-100'))).toThrow(
      PendingExecutionOverflowError,
    );
    expect(registry.get(CLIENT_ID)?.pendingExecutions).toHaveLength(100);
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

    expect(await controller.activateNextExecution(CLIENT_ID)).toBeUndefined();
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
    await activation;

    expect(registry.get(CLIENT_ID)?.currentExecution).toEqual(replacement.token);
  });

  it('does not emit or clear on a stale finish, but finishes current work and activates next', async () => {
    controller.enqueueExecution(CLIENT_ID, prepared('first'));
    controller.enqueueExecution(CLIENT_ID, prepared('next'));
    const first = await controller.activateNextExecution(CLIENT_ID);
    const stale = { ...first!.token!, generation: 99 };
    const before = store.getSessionEvents(SESSION_ID).length;

    const staleResult = await controller.finishExecution(CLIENT_ID, stale, 'failed');
    expect(staleResult.transition.applied).toBe(false);
    expect(store.getSessionEvents(SESSION_ID)).toHaveLength(before);
    expect(registry.get(CLIENT_ID)?.currentExecution).toEqual(first!.token);

    const finished = await controller.finishExecution(CLIENT_ID, first!.token!, 'completed');
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
      CLIENT_ID,
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

    broadcastStoredExecutionEvent(CLIENT_ID, { seq: begun.seq!, event: begun.event! }, registry);

    expect(transport.sent).toEqual([]);
    const replay = store.getEventsAfter(SESSION_ID, 0);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ seq: begun.seq, payload: begun.event });
    registry.dispose();
    store.close();
  });
});

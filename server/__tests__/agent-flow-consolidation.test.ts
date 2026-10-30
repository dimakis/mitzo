import { expect, it, vi } from 'vitest';
import { ConnectionRegistry, SessionRegistry } from '@mitzo/harness';
import { AppliedDelivery } from '../../packages/client/src/applied-delivery.js';
import { CodexSessionEvents } from '../codex-session-events.js';
import { EventStore } from '../event-store.js';
import { replayEventsToTranscript } from '../conversation-transcript.js';
import { runQueryLoop } from '../query-loop.js';
import { projectToolOutput, readToolOutputPage } from '../tool-output-projection.js';

it.each([
  { toolName: 'TelosGetItem', failFirstPrefixWrite: false },
  { toolName: 'ReadToolOutput', failFirstPrefixWrite: true },
])(
  'preserves delayed $toolName ownership through immediate prefix delivery, held ACK and replay',
  async ({ toolName, failFirstPrefixWrite }) => {
    // All providers/services are synthetic; producers, durable store, delivery and
    // transcript projection are the actual owners. No timer-driven retry is started.
    const sessionId = 'combined-flow';
    const events = new EventStore(':memory:');
    events.upsertSession({ sessionId, cwd: '/offline' });
    const connections = new ConnectionRegistry();
    connections.setEventStore(events);
    const sessions = new SessionRegistry();
    const abort = new AbortController();
    let clientCursor = 0;
    const received: Record<string, unknown>[] = [];
    const applied: number[] = [];
    const resync = vi.fn();
    const delivery = new AppliedDelivery({
      getCursor: () => clientCursor,
      setCursor: (_id, seq) => {
        clientCursor = seq;
      },
      deliver: (event) => {
        received.push(event);
        return true;
      },
      // Simulates HTTP ACKs in flight: apply on the client, hold server notification.
      ackEvent: (_id, seq) => {
        applied.push(seq);
      },
      ackSnapshot: () => true,
      resync,
    });
    let failWrite = false;
    const send = vi.fn((event: Record<string, unknown>) => {
      if (failWrite) {
        failWrite = false;
        throw Error('offline socket write failure');
      }
      delivery.receive(event);
    });
    const transport = { send, isOpen: () => true };
    connections.register('phone', transport);
    connections.watch('phone', sessionId);
    connections.enableAppliedCursor('phone', sessionId, 0);
    sessions.register('driver', {
      sessionId,
      cwd: '/offline',
      mode: 'agent',
      transport,
      abortController: abort,
      sessionAllowList: new Set<string>(),
    });
    const session = sessions.get('driver')!;
    const sdk: Record<string, unknown>[] = [];
    const producer = new CodexSessionEvents(sessionId, 'offline-thread', 'offline-model', (event) =>
      sdk.push(event),
    );
    const outputId = '22222222-2222-4222-8222-222222222222';
    const full = 'full evidence '.repeat(2000) + 'needed-evidence';
    const preview = projectToolOutput(full, () => outputId);
    const payload =
      toolName === 'ReadToolOutput'
        ? JSON.stringify(
            readToolOutputPage(full, { offset: 0, limit: 2048, query: 'needed-evidence' }),
          )
        : preview;
    const toolId = producer.toolStart(
      'provider-call',
      toolName,
      toolName === 'ReadToolOutput' ? { outputId } : { itemId: 'existing' },
    );
    const messageIds: string[] = [];
    const drain = function* () {
      while (sdk.length) {
        const event = sdk.shift()!;
        const stream = event.event as { type?: string; message?: { id?: string } } | undefined;
        if (stream?.type === 'message_start') messageIds.push(stream.message!.id!);
        yield event;
      }
    };
    const read = vi.spyOn(events, 'getEventsAfter');
    let observation: Record<string, unknown> | undefined;
    async function* stream() {
      yield* drain();
      producer.notification('item/reasoning/summaryTextDelta', {
        threadId: 'offline-thread',
        itemId: 'new-thinking',
        summaryIndex: 0,
        delta: 'Newer thought',
        turnId: 'turn',
      });
      yield* drain();
      const beforeResult = clientCursor;
      const privateSeq = events.append(sessionId, 'ordinary_reply_source', {
        providerThreadId: 'PRIVATE-PREDECESSOR',
        providerTurnId: 'PRIVATE-TURN',
      });
      failWrite = failFirstPrefixWrite;
      producer.toolResult(toolId, payload, false);
      yield* drain();
      const immediate = received.filter((event) => event.type === 'tool_result');
      const cursorAfterFirstAttempt = clientCursor;
      if (failFirstPrefixWrite) {
        producer.notification('item/reasoning/summaryTextDelta', {
          threadId: 'offline-thread',
          itemId: 'new-thinking',
          summaryIndex: 0,
          delta: ' recovered',
          turnId: 'turn',
        });
        yield* drain();
      }
      // A contiguous delta must stream without rereading or resending an already
      // forwarded prefix, even though no application ACK has reached the registry.
      read.mockClear();
      const writesBeforeContiguous = send.mock.calls.length;
      producer.notification('item/reasoning/summaryTextDelta', {
        threadId: 'offline-thread',
        itemId: 'new-thinking',
        summaryIndex: 0,
        delta: ' continues',
        turnId: 'turn',
      });
      yield* drain();
      const readsOnContiguous = read.mock.calls.length;
      const writesOnContiguous = send.mock.calls.length - writesBeforeContiguous;
      const last = clientCursor;
      read.mockClear();
      const prematureAck = connections.ackAppliedEvents('phone', sessionId, [last]);
      const oldRegistryCursor = read.mock.calls[0]?.[1];
      const exactAck = connections.ackAppliedEvents('phone', sessionId, [...applied]);
      read.mockClear();
      const duplicateAck = connections.ackAppliedEvents('phone', sessionId, [last]);
      const readsAfterDuplicateAck = read.mock.calls.length;
      const immutable = events.getSessionEvents(sessionId);
      const saved = structuredClone(immutable);
      const transcript = replayEventsToTranscript(immutable);
      observation = {
        beforeResult,
        privateSeq,
        immediate,
        cursorAfterFirstAttempt,
        readsOnContiguous,
        writesOnContiguous,
        prematureAck,
        oldRegistryCursor,
        exactAck,
        duplicateAck,
        readsAfterDuplicateAck,
        transcript,
        snapshot: structuredClone(session.currentSnapshot),
        unchanged: JSON.stringify(immutable) === JSON.stringify(saved),
        storedResult: immutable.find((event) => event.type === 'tool_result')?.payload,
      };
      // No terminal/result event: the captured transcript retains thinking B.
    }
    try {
      await runQueryLoop(stream(), 'driver', sessions, abort, events, undefined, {
        connRegistry: connections,
      });
      expect(messageIds).toHaveLength(2);
      const [callMessage, thinkingMessage] = messageIds;
      const result = received.filter((event) => event.type === 'tool_result');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ messageId: callMessage, toolId, result: payload });
      expect(observation).toBeDefined();
      expect(observation!.storedResult).toMatchObject({
        messageId: callMessage,
        toolId,
        result: payload,
      });
      expect(observation!.snapshot).toMatchObject({ messageId: thinkingMessage });
      expect(observation!.immediate).toHaveLength(failFirstPrefixWrite ? 0 : 1);
      if (failFirstPrefixWrite)
        expect(observation!.cursorAfterFirstAttempt).toBe(observation!.beforeResult);
      expect(
        JSON.stringify(received.find((event) => event.seq === observation!.privateSeq)),
      ).not.toContain('PRIVATE-');
      expect(received.some((event) => event.seq === observation!.privateSeq)).toBe(true);
      expect(observation).toMatchObject({
        readsOnContiguous: 0,
        writesOnContiguous: 1,
        prematureAck: false,
        oldRegistryCursor: 0,
        exactAck: true,
        duplicateAck: true,
        readsAfterDuplicateAck: 0,
        unchanged: true,
      });
      const transcript = observation!.transcript as ReturnType<typeof replayEventsToTranscript>;
      expect(
        transcript.messages
          .find((message) => message.messageId === callMessage)
          ?.blocks.find((block) => block.toolId === toolId),
      ).toMatchObject({ toolResult: payload });
      expect(transcript.current).toMatchObject({ messageId: thinkingMessage });
      expect(resync).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      delivery.clearPending();
      connections.dispose();
      sessions.dispose();
      events.close();
    }
  },
);

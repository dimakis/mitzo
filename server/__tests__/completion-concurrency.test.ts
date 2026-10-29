import { expect, it, vi } from 'vitest';
import { ConnectionRegistry, SessionRegistry } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { CodexSessionEvents } from '../codex-session-events.js';
import { runQueryLoop } from '../query-loop.js';
import { replayEventsToTranscript } from '../conversation-transcript.js';
import { singleFlightReconciliation } from '../single-flight-reconciliation.js';

it('keeps two persisted synthetic turns flowing with history switching and held maintenance', async () => {
  const events = new EventStore(':memory:');
  const sessions = new SessionRegistry();
  const connections = new ConnectionRegistry();
  connections.setEventStore(events);
  let release!: () => void;
  const maintenance = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const maintenanceError = vi.fn();
  const tick = singleFlightReconciliation(maintenance, maintenanceError);
  const history = vi.spyOn(events, 'getSessionEvents');
  const sent = new Map<string, Array<Record<string, unknown>>>();
  const run = async (id: string, other: string) => {
    events.upsertSession({ sessionId: id, cwd: `/offline/${id}` });
    const delivered: Array<Record<string, unknown>> = [];
    sent.set(id, delivered);
    const transport = {
      send: (event: Record<string, unknown>) => delivered.push(event),
      isOpen: () => true,
    };
    const abort = new AbortController();
    sessions.register(id, {
      sessionId: id,
      cwd: `/offline/${id}`,
      mode: 'agent',
      transport,
      abortController: abort,
      sessionAllowList: new Set<string>(),
    });
    const sdk: Record<string, unknown>[] = [];
    const producer = new CodexSessionEvents(
      id,
      `thread-${id}`,
      'offline',
      (event) => sdk.push(event),
      { requireExactTurnIdentity: true },
    );
    function* drain() {
      while (sdk.length) yield sdk.shift()!;
    }
    async function* stream() {
      for (let i = 0; i < 25; i++) {
        const turnId = `${id}-${i}`;
        producer.notification('turn/started', { threadId: `thread-${id}`, turn: { id: turnId } });
        producer.notification('item/agentMessage/delta', {
          threadId: `thread-${id}`,
          turnId,
          itemId: turnId,
          delta: `${id} text ${i}`,
        });
        yield* drain();
        const toolId = producer.toolStart(`${id}-call-${i}`, 'Read', {
          file_path: `/offline/${id}/file`,
        });
        yield* drain();
        tick();
        // A delayed external maintenance effect stays held while both genuine
        // stream owners interleave and history selects immutable stored prefixes.
        await new Promise<void>((resolve) => setImmediate(resolve));
        replayEventsToTranscript(events.getSessionEvents(other));
        producer.toolResult(toolId, `${id} result ${i}`, false);
        producer.notification('turn/completed', {
          threadId: `thread-${id}`,
          turn: { id: turnId, status: 'completed' },
        });
        yield* drain();
      }
    }
    await runQueryLoop(stream(), id, sessions, abort, events, undefined, {
      connRegistry: connections,
    });
  };
  try {
    await Promise.all([run('alpha', 'beta'), run('beta', 'alpha')]);
    expect(maintenance).toHaveBeenCalledOnce();
    expect(maintenanceError).not.toHaveBeenCalled();
    expect(history).toHaveBeenCalledTimes(50);
    for (const id of ['alpha', 'beta']) {
      const prefix = events.getSessionEvents(id);
      const transcript = replayEventsToTranscript(prefix);
      const tools = transcript.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.toolId);
      expect(tools).toHaveLength(25);
      expect(tools.every((block) => block.toolResult?.startsWith(`${id} result `))).toBe(true);
      expect(JSON.stringify(transcript)).not.toContain(id === 'alpha' ? 'beta text' : 'alpha text');
      expect(sent.get(id)!.filter((event) => event.type === 'tool_result')).toHaveLength(25);
    }
  } finally {
    release?.();
    await Promise.resolve();
    connections.dispose();
    sessions.dispose();
    events.close();
  }
});

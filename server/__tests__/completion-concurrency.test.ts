import { expect, it, vi } from 'vitest';
import { ConnectionRegistry, SessionRegistry } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { CodexSessionEvents } from '../codex-session-events.js';
import { runQueryLoop } from '../query-loop.js';
import { replayEventsToTranscript } from '../conversation-transcript.js';
import { singleFlightReconciliation } from '../single-flight-reconciliation.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const measure = process.env.MITZO_MEASURE_COMPLETION;
const reportPath = process.env.MITZO_COMPLETION_REPORT;

it.each(measure ? Array.from({ length: 11 }, (_, i) => i) : [0])(
  'keeps two persisted synthetic sessions flowing with replay, held maintenance and interrupted recovery (sample %s)',
  async (sample) => {
    let measuring = false;
    const counts = {
      sqlReads: 0,
      sqlWrites: 0,
      sqlRows: 0,
      sqlRowBytes: 0,
      deliveredBytes: 0,
      replayBytes: 0,
      peakQueued: 0,
      syntheticProviderTurns: 0,
    };
    const prepare = Database.prototype.prepare;
    const sql = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      query: string,
    ) {
      const statement = prepare.call(this, query);
      const observeRows = (value: unknown) => {
        if (!measuring || value === undefined) return;
        const rows = Array.isArray(value) ? value : [value];
        counts.sqlRows += rows.length;
        counts.sqlRowBytes += Buffer.byteLength(JSON.stringify(value));
      };
      return new Proxy(statement, {
        get(target, key) {
          if (key === 'get' || key === 'all')
            return (...args: unknown[]) => {
              if (measuring) counts.sqlReads++;
              const value: unknown = Reflect.apply(target[key], target, args);
              observeRows(value);
              return value;
            };
          if (key === 'iterate')
            return function* (...args: unknown[]) {
              if (measuring) counts.sqlReads++;
              for (const row of Reflect.apply(target.iterate, target, args)) {
                observeRows(row);
                yield row;
              }
            };
          if (key === 'run')
            return (...args: unknown[]) => {
              if (measuring) counts.sqlWrites++;
              return Reflect.apply(target.run, target, args);
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    const root = mkdtempSync(join(tmpdir(), 'mitzo-completion-concurrency-'));
    const native = new CodexConversationStore(join(root, 'native.db'));
    const account = {
      accountId: 'offline',
      accountLabel: 'Offline',
      provider: 'openai' as const,
      model: 'synthetic',
      profileRevision: 'r1',
    };
    for (const id of ['alpha', 'beta']) {
      native.create(id, account, `/offline/${id}`);
      native.bindThread(id, account, `thread-${id}`);
      for (let i = 0; i < 200; i++) {
        const commandId = `${id}-history-${i}`;
        native.enqueue(id, account, { id: commandId, prompt: 'retained' });
        const command = native.claimNext(id, account)!;
        native.recordNativeTurnAck(id, account, command, `thread-${id}`, commandId);
        native.finish(id, account, commandId, 'completed', commandId);
      }
    }
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
        send: (event: Record<string, unknown>) => {
          counts.deliveredBytes += Buffer.byteLength(JSON.stringify(event));
          delivered.push(event);
        },
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
          native.enqueue(id, account, { id: turnId, prompt: turnId });
          const command = native.claimNext(id, account)!;
          expect(command.id).toBe(turnId);
          native.recordNativeTurnAck(id, account, command, `thread-${id}`, turnId);
          counts.syntheticProviderTurns++;
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
          const identity = { turnId, toolName: 'Read', requestHash: 'a'.repeat(64) };
          native.claimTool(id, account, turnId, toolId, identity);
          yield* drain();
          tick();
          // A delayed external maintenance effect stays held while both genuine
          // stream owners interleave and history selects immutable stored prefixes.
          await new Promise<void>((resolve) => setImmediate(resolve));
          counts.replayBytes += Buffer.byteLength(
            JSON.stringify(replayEventsToTranscript(events.getSessionEvents(other))),
          );
          native.recordToolResult(id, account, turnId, toolId, identity, {
            content: `${id} result ${i}`,
            isError: false,
          });
          if (i === 12) {
            native.enqueue(id, account, { id: `${id}-13`, prompt: `${id}-13` });
            counts.peakQueued = Math.max(
              counts.peakQueued,
              native.queueSummary(id, account).queued,
            );
            native.pauseForRecovery(
              id,
              account,
              turnId,
              'interrupted',
              'resume',
              undefined,
              true,
              true,
              false,
            );
            const state = native.read(id, account);
            expect(native.recoveryProbeThreadId(id, account)).toBe(`thread-${id}`);
            const target = native.nativeRecoveryTarget(id, account)!;
            expect(target.commandId).toBe(turnId);
            native.reconcileNativeRecovery(
              id,
              account,
              target,
              'completed',
              state.threadId,
              state.threadGeneration,
            );
            native.acknowledgeRecovery(id, account, target);
          } else native.finish(id, account, turnId, 'completed', turnId);
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
    let eventLoopMaxMs = 0;
    let previousTick = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      eventLoopMaxMs = Math.max(eventLoopMaxMs, now - previousTick);
      previousTick = now;
    }, 1);
    measuring = true;
    const started = performance.now();
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
        expect(JSON.stringify(transcript)).not.toContain(
          id === 'alpha' ? 'beta text' : 'alpha text',
        );
        expect(sent.get(id)!.filter((event) => event.type === 'tool_result')).toHaveLength(25);
      }
      expect(counts.syntheticProviderTurns).toBe(50);
      expect(counts.peakQueued).toBe(1);
      if (measure) {
        const report = JSON.stringify({
          workload: 'two-session-stream-replay-tool-maintenance-recovery',
          sample,
          ...counts,
          workflowMs: performance.now() - started,
          eventLoopMaxMs,
          helperProcesses: 0,
          credentialRefreshes: 0,
          providerRpcs: 0,
          realModelCalls: 0,
        });
        if (reportPath) appendFileSync(reportPath, report + '\n');
        else console.log(report);
      }
    } finally {
      clearInterval(timer);
      measuring = false;
      release?.();
      await Promise.resolve();
      connections.dispose();
      sessions.dispose();
      events.close();
      native.close();
      sql.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

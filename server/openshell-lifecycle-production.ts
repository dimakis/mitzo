import type { OpenShellLifecycleRecord } from './openshell-lifecycle.js';
import type { LifecycleAdapters, LifecycleBlocker } from './openshell-lifecycle-service.js';

export interface LifecycleProductionDependencies {
  registry: {
    findBySessionId(id: string): unknown;
    entries(): IterableIterator<[string, { sessionId?: string }]>;
  };
  eventStore: {
    getSession(id: string): { symposiumConfig?: string | null; sessionType?: string } | undefined | null;
  };
  taskStore: {
    getTree(): Array<{ sessionId: string | null; status: string; children: unknown[] }>;
  };
  queue: (record: OpenShellLifecycleRecord) => {
    queued: number;
    running: number;
    recovery: boolean;
  };
  inspect(
    record: OpenShellLifecycleRecord,
    signal: AbortSignal,
  ): ReturnType<LifecycleAdapters['inspect']>;
  stop(record: OpenShellLifecycleRecord, signal: AbortSignal): Promise<void>;
  delete(record: OpenShellLifecycleRecord, signal: AbortSignal): Promise<void>;
  checkpoint(
    record: OpenShellLifecycleRecord,
    sandbox: NonNullable<Awaited<ReturnType<LifecycleAdapters['inspect']>>>,
    signal: AbortSignal,
  ): ReturnType<NonNullable<LifecycleAdapters['checkpoint']>>;
  verifyCheckpoint(
    record: OpenShellLifecycleRecord,
    sandbox: NonNullable<Awaited<ReturnType<LifecycleAdapters['inspect']>>>,
    signal: AbortSignal,
  ): Promise<boolean>;
  consent?(record: OpenShellLifecycleRecord): boolean;
}
const terminal = new Set(['done', 'skipped', 'failed']);
function flatten(
  tasks: Array<{ sessionId: string | null; status: string; children: unknown[] }>,
): typeof tasks {
  return tasks.flatMap((task) => [task, ...flatten(task.children as typeof tasks)]);
}
/** Real adapter composition; every reader failure is intentionally a blocker. */
export function createOpenShellLifecycleProductionAdapter(
  deps: LifecycleProductionDependencies,
): LifecycleAdapters {
  return {
    inspect: deps.inspect,
    stop: deps.stop,
    delete: deps.delete,
    checkpoint: deps.checkpoint,
    verifyCheckpoint: deps.verifyCheckpoint,
    consent: deps.consent,
    async protect(record): Promise<{ blockers: LifecycleBlocker[] }> {
      try {
        if (!record.identity) return { blockers: ['ambiguous_ownership'] };
        const blockers: LifecycleBlocker[] = [];
        if (deps.registry.findBySessionId(record.conversationId)) blockers.push('active_session');
        const q = deps.queue(record);
        if (q.recovery || q.queued || q.running) blockers.push('queued_work');
        // Task Board persists client IDs. Resolve those through the registry;
        // direct conversation IDs remain supported for records written before
        // the client/conversation split. An unresolvable non-terminal owner is
        // ambiguous and therefore blocks mutation.
        const clients = new Map<string, string | undefined>(
          [...deps.registry.entries()].map(([clientId, session]) => [clientId, session.sessionId]),
        );
        if (flatten(deps.taskStore.getTree()).some((task) => {
          if (terminal.has(task.status)) return false;
          if (task.sessionId === record.conversationId) return true;
          if (task.sessionId && clients.get(task.sessionId) === record.conversationId) return true;
          return false;
        }))
          blockers.push('task_board');
        const session = deps.eventStore.getSession(record.conversationId);
        // Missing event history means we cannot prove this is an ordinary,
        // single-owner chat. Treat it as unavailable rather than an empty row.
        if (!session) blockers.push('inventory_unavailable');
        else if (session.sessionType === 'symposium' || session.symposiumConfig)
          blockers.push('symposium');
        return { blockers };
      } catch {
        return { blockers: ['inventory_unavailable'] };
      }
    },
  };
}

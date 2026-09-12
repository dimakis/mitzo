import type { OpenShellLifecycleRecord } from './openshell-lifecycle.js';
import type { LifecycleAdapters, LifecycleBlocker } from './openshell-lifecycle-service.js';

export interface LifecycleProductionDependencies {
  registry: {
    findBySessionId(id: string): unknown;
    entries(): IterableIterator<[string, { sessionId?: string }]>;
  };
  eventStore: {
    getSession(id: string): { symposiumConfig?: string | null; sessionType?: string } | undefined;
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
    async protect(record): Promise<{ blockers: LifecycleBlocker[] }> {
      try {
        if (!record.identity) return { blockers: ['ambiguous_ownership'] };
        const blockers: LifecycleBlocker[] = [];
        if (deps.registry.findBySessionId(record.conversationId)) blockers.push('active_session');
        const q = deps.queue(record);
        if (q.recovery || q.queued || q.running) blockers.push('queued_work');
        if (
          flatten(deps.taskStore.getTree()).some(
            (task) => task.sessionId === record.conversationId && !terminal.has(task.status),
          )
        )
          blockers.push('task_board');
        const session = deps.eventStore.getSession(record.conversationId);
        if (session?.sessionType === 'symposium' || session?.symposiumConfig)
          blockers.push('symposium');
        return { blockers };
      } catch {
        return { blockers: ['inventory_unavailable'] };
      }
    },
  };
}

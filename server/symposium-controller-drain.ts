import type { EventStore } from './event-store.js';
interface Runtime {
  beginShutdown(): void;
  drain(signal: AbortSignal): Promise<void>;
}
/** The original runtime objects provide cleanup authority. The map is never
 * rebuilt from stored IDs by a replacement app or custodian. */
export async function drainRetainedSymposiumControllers<T extends { runtime: Runtime }>(
  store: EventStore,
  runtimes: Map<string, T>,
  controllerIdentity: string,
  signal: AbortSignal,
) {
  const entries = [...runtimes];
  const suspended: ReturnType<EventStore['suspendSymposiumForControllerLoss']> = [];
  let failed = false;
  for (const [sessionId, { runtime }] of entries) {
    runtime.beginShutdown();
    try {
      const latest = new Map<
        string,
        ReturnType<EventStore['getSymposiumMembershipHistory']>[number]
      >();
      for (const row of store.getSymposiumMembershipHistory(sessionId))
        if (!latest.has(row.seatId) || latest.get(row.seatId)!.generation < row.generation)
          latest.set(row.seatId, row);
      if (![...latest.values()].some((row) => row.state === 'active')) continue;
      const config = store.getActiveSymposiumConfig(sessionId);
      suspended.push(
        ...store.suspendSymposiumForControllerLoss(
          sessionId,
          config.revision,
          controllerIdentity,
          Date.now(),
        ),
      );
    } catch {
      failed = true;
    }
  }
  // A failed sibling fence must not prevent stopping the workloads we still own.
  const drained = await Promise.allSettled(entries.map(([, entry]) => entry.runtime.drain(signal)));
  signal.throwIfAborted();
  if (drained.some((result) => result.status === 'rejected')) failed = true;
  if (failed) throw Error('Retained controller cleanup is incomplete');
  for (const row of suspended) {
    signal.throwIfAborted();
    if (store.getUnsettledSymposiumSeatExecutions(row.sessionId, row.seatId).length)
      throw Error('Retained controller attempt cleanup remains uncertain');
    store.markSymposiumMembershipReconciled(row.sessionId, row.seatId, row.generation, 'confirmed');
  }
  for (const [sessionId, entry] of entries)
    if (runtimes.get(sessionId) === entry) runtimes.delete(sessionId);
}

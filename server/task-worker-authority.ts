import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { EventStore } from './event-store.js';
import type { SessionRegistry, ManagedSession } from './session-registry.js';
import type { TaskStore } from './task-store.js';
import { resolveTelosWorkTaskToolContext } from './telos-work-execution-authority.js';

export const TASK_WORKER_ALLOCATION_EVENT = 'ordinary_task_worker_allocation';
const reference = z.string().min(1).max(200).regex(/^\S+$/);
const Allocation = z.strictObject({
  version: z.literal(1),
  taskId: reference,
  goalId: reference,
  operationId: reference,
  workerClientId: reference,
  conversationId: reference,
});
type AllocationRecord = z.infer<typeof Allocation>;
type AllocationEvents = Pick<EventStore, 'getEventsOfType' | 'append'>;

/** Historical markers are retained. Only the last exact marker selects the
 * current allocation; finding an older operation anywhere is never authority. */
export function latestTaskWorkerMarker(
  annotations: readonly string[],
  kind: 'allocation' | 'conversation',
): string | null {
  const prefix = `worker_${kind}: `;
  const saved = [...annotations].reverse().find((value) => value.startsWith(prefix));
  if (saved === undefined) return null;
  const parsed = reference.safeParse(saved.slice(prefix.length));
  return parsed.success ? parsed.data : null;
}
function readAllocation(
  events: Pick<EventStore, 'getEventsOfType'>,
  sessionId: string,
): AllocationRecord | null {
  const records = events.getEventsOfType(sessionId, TASK_WORKER_ALLOCATION_EVENT, 2);
  if (records.length === 0) return null;
  if (records.length !== 1) throw Error('Ambiguous ordinary worker allocation proof');
  const record = Allocation.parse(records[0].payload);
  if (
    record.conversationId !== sessionId ||
    record.workerClientId !== `task-worker:${record.operationId}`
  )
    throw Error('Original ordinary worker allocation identity required');
  return record;
}
/** Record attribution in the existing event owner before building task tools.
 * Repeated setup may confirm the exact same receipt, never replace its owner. */
export function retainTaskWorkerAllocation(
  events: AllocationEvents,
  input: AllocationRecord,
): void {
  const selected = Allocation.parse(structuredClone(input));
  if (selected.workerClientId !== `task-worker:${selected.operationId}`)
    throw Error('Original ordinary worker client required');
  const previous = readAllocation(events, selected.conversationId);
  if (previous) {
    if (!isDeepStrictEqual(previous, selected))
      throw Error('Original ordinary worker allocation changed');
    return;
  }
  events.append(selected.conversationId, TASK_WORKER_ALLOCATION_EVENT, selected);
}
function assertTaskAllocation(tasks: Pick<TaskStore, 'get'>, record: AllocationRecord): void {
  const task = tasks.get(record.taskId);
  if (
    !task ||
    task.sessionId !== record.workerClientId ||
    latestTaskWorkerMarker(task.annotations, 'allocation') !== record.operationId ||
    latestTaskWorkerMarker(task.annotations, 'conversation') !== record.conversationId
  )
    throw Error('Ordinary worker allocation is superseded or no longer owns this task');
}
/** Read-only cold reconstruction under the existing native session owner. A
 * stale or incomplete record does not restore tool authority. */
export function resolveTaskWorkerAllocationContext(
  events: Pick<EventStore, 'getEventsOfType'>,
  tasks: Pick<TaskStore, 'get'>,
  sessionId: string,
): ManagedSession['taskContext'] {
  const record = readAllocation(events, sessionId);
  if (!record) return null;
  assertTaskAllocation(tasks, record);
  return {
    currentTaskId: record.taskId,
    goalId: record.goalId,
    workerAllocationId: record.operationId,
  };
}
export interface TaskEffectAuthority {
  assertCurrent(): void;
}
export interface TaskToolExecution extends TaskEffectAuthority {
  readonly taskId: string;
}
type TelosOwners = Parameters<typeof resolveTelosWorkTaskToolContext>[0];
interface TaskToolOwners extends Omit<TelosOwners, 'tasks' | 'events'> {
  tasks: TelosOwners['tasks'] & Pick<TaskStore, 'get'>;
  events: TelosOwners['events'] & Pick<EventStore, 'getEventsOfType' | 'getSession'>;
  registry: Pick<SessionRegistry, 'get' | 'findBySessionId'>;
}
/** Capture a trusted live task context, then recheck the actual store, retained
 * allocation and session object immediately before every mutation. Viewer
 * rekeys keep the same session object; they do not change the logical worker. */
export function captureTaskToolExecution(
  owners: TaskToolOwners,
  input: { clientId: string; expected: { sessionId: unknown; taskId: unknown } },
): TaskToolExecution | null {
  let session = owners.registry.get(input.clientId);
  // The task MCP process keeps its original logical worker client id when a
  // viewer reconnect rekeys the live native session. Only the immutable receipt
  // may connect that old callback id to the current registered session.
  if (!session && typeof input.expected.sessionId === 'string') {
    try {
      const proof = readAllocation(owners.events, input.expected.sessionId);
      if (proof?.workerClientId === input.clientId && proof.taskId === input.expected.taskId)
        session = owners.registry.findBySessionId(proof.conversationId)?.session;
    } catch {
      return null;
    }
  }
  const sessionId = session?.sessionId,
    context = session?.taskContext;
  if (!session || !sessionId || !context) return null;
  const captured = structuredClone(context);
  const assertCurrent = () => {
    if (!isDeepStrictEqual(session.taskContext, captured))
      throw Error('Current task session owner changed');
    const taskId = resolveTelosWorkTaskToolContext(
      owners,
      {
        sessionId,
        taskId: captured.currentTaskId,
        accountBinding: owners.events.getSession(sessionId)?.accountBinding ?? undefined,
      },
      input.expected,
    );
    if (taskId !== captured.currentTaskId) throw Error('Original task callback context required');
    const task = owners.tasks.get(taskId);
    if (!task) throw Error('Current task is unavailable');
    const proof = readAllocation(owners.events, sessionId);
    const workerSelected =
      !!proof ||
      captured.workerAllocationId !== undefined ||
      (task.sessionPolicy !== 'reuse' &&
        task.annotations.some((value) => value.startsWith('worker_allocation: ')));
    if (!workerSelected) {
      if (owners.registry.get(input.clientId) !== session)
        throw Error('Current task session owner changed');
      return;
    }
    if (owners.registry.findBySessionId(sessionId)?.session !== session)
      throw Error('Current ordinary worker session owner changed');
    session.abortController.signal.throwIfAborted();
    if (
      !proof ||
      captured.workerAllocationId !== proof.operationId ||
      proof.taskId !== taskId ||
      proof.goalId !== captured.goalId ||
      input.expected.sessionId !== sessionId ||
      input.expected.taskId !== taskId
    )
      throw Error('Exact retained ordinary worker context required');
    assertTaskAllocation(owners.tasks, proof);
  };
  try {
    assertCurrent();
    return Object.freeze({ taskId: captured.currentTaskId, assertCurrent });
  } catch {
    return null;
  }
}

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { vi } from 'vitest';
import { createTelosOrdinaryWorkFixture } from './telos-ordinary-work.js';
import { createTelosWorkDelegationHost } from '../../telos-work-delegation-host.js';
import { TaskStore } from '../../task-store.js';
import { TaskOrchestrator } from '../../task-orchestrator.js';

/** Actual ordinary allocation and both durable execution owners; no provider turn. */
export async function createTelosWorkerMaterialsFixture(
  cleanup: Array<() => void | Promise<void>>,
) {
  const f = await createTelosOrdinaryWorkFixture(cleanup);
  const lead = await f.owner.setup(f.actor, f.input, f.native.signal.signal);
  const leadId = lead.work.assignments[0].conversation.conversationId;
  for (const id of ['slice', 'sibling']) {
    f.db
      .prepare(
        "INSERT INTO items(id,parent_id,summary,intent,rationale,acceptance_criteria,profile,priority,first_seen,last_seen,created_at,updated_at) VALUES(?,'studio',?,'Arrange studio','Retain ownership','[\"Retained plan\"]','manual',8,?,?,?,?)",
      )
      .run(id, id, f.canonical.stamp, f.canonical.stamp, f.canonical.stamp, f.canonical.stamp);
    f.work.execute(
      {
        operation: 'classify',
        kind: 'work_item',
        itemId: id,
        requestId: randomUUID(),
        expectedRevision: f.work.read(id, f.actor).revision,
      },
      f.actor,
    );
  }
  const tasks = new TaskStore(join(f.native.root, 'worker-material-tasks.db'));
  cleanup.push(() => tasks.close());
  const noLaunch = () => {
    throw Error('Provider turns forbidden in this fixture');
  };
  const orchestrator = new TaskOrchestrator({
    store: tasks,
    getClientId: noLaunch,
    setTaskContext: vi.fn(),
    clearTaskContext: vi.fn(),
    broadcastStatus: vi.fn(),
    broadcastTasks: vi.fn(),
  });
  const resolve = async () => ({
    binding: f.native.binding,
    agentProfile: f.native.first.reserved.agentProfile,
    taskRoot: f.native.taskRoot,
    requiredCapabilities: ['ordinary_conversation', 'task_execution'],
  });
  const host = createTelosWorkDelegationHost({
    dbPath: () => f.canonical.dbPath,
    events: f.native.events,
    tasks,
    workspaces: () => f.native.workspaces,
    ordinaryConversation: (id) =>
      !!f.native.events.getSession(id) && !f.native.events.getSession(id)?.isHidden,
    resolvePreparation: noLaunch,
    authorizeSettings: noLaunch,
    dispatch: noLaunch,
    ordinary: {
      resolvePreparation: resolve,
      qualifySettings: resolve,
      authorizeSettings: async () => {},
      dispatch: (owner, actor, input, signal) =>
        orchestrator.delegateSlice(owner, actor, input, signal),
    },
  });
  const delegated = await host.delegateOrdinary({
    actor: { kind: 'conversation', id: leadId },
    raw: {
      requestId: randomUUID(),
      childItemId: 'slice',
      mode: 'start',
      predecessorAttemptId: null,
    },
    signal: f.native.signal.signal,
    assertAuthorized() {},
  });
  const workerId = delegated.workerConversationId;
  const taskId = delegated.attempt.executionTaskId!;
  const output = f.canonical.artifacts.save({
    itemId: 'slice',
    sessionId: workerId,
    filename: 'worker-result.md',
    title: 'Worker result',
    bytes: Buffer.from('Exact worker-authored result'),
  });
  tasks.update(taskId, { artifacts: { result: `artifact:${output.id}@${output.revision}` } });
  const own = f.canonical.artifacts.save({
    itemId: 'studio',
    sessionId: leadId,
    filename: 'lead-notes.md',
    title: 'Lead notes',
    bytes: Buffer.from('Original lead material'),
  });
  return { f, leadId, workerId, taskId, tasks, output, own, host };
}

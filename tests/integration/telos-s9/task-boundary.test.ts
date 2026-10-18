import { afterEach, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { createS9Fixture, cleanupS9Fixtures } from './fixture.js';
import { TaskStore } from '../../../server/task-store.js';
import { TaskOrchestrator } from '../../../server/task-orchestrator.js';
import { handleTaskComplete } from '../../../server/task-tools.js';
import { assertTelosWorkTaskExecutionScope } from '../../../server/telos-work-role-context.js';
// This test reaches the real dispatcher. Its outgoing ordinary-chat port is
// deterministic; native queue ownership is covered separately in shared-effects.
vi.mock('../../../server/chat.js', () => ({ sendToChat: vi.fn(async () => true) }));
import { sendToChat } from '../../../server/chat.js';

afterEach(async () => {
  vi.clearAllMocks();
  await cleanupS9Fixtures();
});

it('CT17/CT18 partial: real task dispatcher enforces retained Telos role scope without blocking unrelated Symposium work; review stays explicit', async () => {
  const f = await createS9Fixture();
  const selection = await f.api.roleContext({
    itemId: 'outcome',
    role: 'lead',
    sourceSnapshotIds: [],
    artifactRefs: [],
  });
  const receipt = await f.api.setupRole({
    itemId: 'outcome',
    role: 'lead',
    requestId: 'lead',
    expectedRevision: selection.brief.revision,
    expectedAssignmentRevision: 0,
    settings: f.ordinary.input.settings,
    contextSelection: selection,
  });
  const leadId = receipt.work.assignments[0].conversation.conversationId;
  const member = await f.ordinary
    .owner()
    .confirm(
      'operator',
      f.ordinary.group,
      f.joiningInput(await f.independentSettings()),
      f.ordinary.signal,
    );
  const path = join(dirname(f.dbPath), 'tasks.db');
  let store = new TaskStore(path);
  const create = (clientId: string) =>
    new TaskOrchestrator({
      store,
      getClientId: () => clientId,
      assertTaskExecutionScope: (id, taskId) =>
        assertTelosWorkTaskExecutionScope(
          f.events,
          id,
          f.events.getSession(id)?.accountBinding ?? undefined,
          taskId,
        ),
      setTaskContext: vi.fn(),
      clearTaskContext: vi.fn(),
      broadcastStatus: vi.fn(),
      broadcastTasks: vi.fn(),
    });
  const lead = create(leadId),
    symposium = create(member.sessionId!);
  try {
    const goal = store.create({ title: 'Unrelated Symposium outcome' });
    const task = store.create({
      title: 'Review evidence',
      parentId: goal.id,
      sessionPolicy: 'reuse',
    });
    store.update(task.id, { requiresApproval: true });
    expect(() => lead.start(goal.id)).toThrow('does not authorize task execution');
    expect(sendToChat).not.toHaveBeenCalled();
    expect(store.get(task.id)?.status).toBe('pending');
    symposium.start(goal.id);
    await vi.waitFor(() => expect(sendToChat).toHaveBeenCalledOnce());
    expect(vi.mocked(sendToChat).mock.calls[0][0]).toBe(member.sessionId);
    expect(store.get(task.id)?.status).toBe('active');
    expect(handleTaskComplete(store, task.id, 'Synthetic reviewed output retained')).toContain(
      'pending_review',
    );
    symposium.onTaskCompleted(task.id);
    expect(store.get(task.id)?.status).toBe('pending_review');
    expect(store.get(goal.id)?.status).toBe('pending_review');
    symposium.stop();
    store.close();
    store = new TaskStore(path);
    expect(store.get(task.id)).toMatchObject({
      status: 'pending_review',
      summary: 'Synthetic reviewed output retained',
    });
    expect(create(member.sessionId!).approveTask(task.id)).toBe(true);
    expect(store.get(task.id)?.status).toBe('done');
    // Task approval proves neither canonical Telos outcome verification nor deployment.
    expect(f.canonicalStatus('outcome')).toBe('active');
    expect((await f.api.read('outcome')).attempts).toEqual([]);
  } finally {
    lead.stop();
    symposium.stop();
    store.close();
  }
});

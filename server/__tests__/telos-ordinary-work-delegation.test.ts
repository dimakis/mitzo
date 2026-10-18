import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createTelosOrdinaryWorkFixture } from './fixtures/telos-ordinary-work.js';
import { eventStore as startupStore } from '../chat.js';
import { setAuthRevocationStore, isAuthSessionCurrent, revokeAuthSession } from '../auth.js';
import { TelosWorkDelegation } from '../telos-work-delegation.js';
import { TaskStore } from '../task-store.js';
import { reviewTelosWorkRoleContext } from '../telos-work-role-review.js';
// Isolate chat's legacy startup metadata before imports. This is not a Git source
// or an admitted workspace; every actual task must use its separate private ID/cwd.
const startup = await vi.hoisted(async () => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-native-startup-')));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', path.join(root, 'controller-private'));
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', undefined);
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_OWNER', undefined);
  return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
});
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: 'synthetic-only-ordinary-native-token',
  isValidInternalToken: () => false,
  createSignalCallbackToken: vi.fn(() => 'synthetic-callback'),
  revokeSignalCallbackToken: vi.fn(),
  isValidSignalCallbackToken: () => false,
}));
vi.mock('../mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
  loadFromFile: () => ({}),
}));
beforeAll(() => setAuthRevocationStore(startupStore));
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
afterAll(() => {
  startupStore.close();
  startup.remove();
  vi.unstubAllEnvs();
});

async function fixture() {
  const f = await createTelosOrdinaryWorkFixture(cleanup);
  const lead = await f.owner.setup(f.actor, f.input, f.native.signal.signal);
  const leadConversationId = lead.work.assignments[0].conversation.conversationId;
  for (const [id, summary] of [
    ['slice', 'Arrange acoustic panels'],
    ['sibling', 'Choose microphones'],
  ]) {
    f.db
      .prepare(
        "INSERT INTO items(id,parent_id,summary,intent,rationale,acceptance_criteria,profile,priority,first_seen,last_seen,created_at,updated_at) VALUES(?,'studio',?,'Plan the studio','Preserve independent ownership','[\"Retained plan\"]','manual',8,?,?,?,?)",
      )
      .run(id, summary, f.canonical.stamp, f.canonical.stamp, f.canonical.stamp, f.canonical.stamp);
    f.work.execute(
      {
        operation: 'classify',
        kind: 'work_item',
        itemId: id,
        requestId: 'kind-' + id,
        expectedRevision: f.work.read(id, f.actor).revision,
      },
      f.actor,
    );
  }
  const contextSelection = reviewTelosWorkRoleContext({
    work: f.work,
    artifacts: f.canonical.artifacts,
    actor: f.actor,
    itemId: 'slice',
    role: 'worker',
    selectedSourceSnapshotIds: [],
    selectedArtifactRefs: [],
  });
  const input = {
    version: 2 as const,
    requestId: randomUUID(),
    leadItemId: 'studio',
    childItemId: 'slice',
    leadConversationId,
    expectedRevision: contextSelection.brief.revision,
    mode: 'start' as const,
    predecessorAttemptId: null,
    settings: f.input.settings,
    contextSelection,
  };
  let tasks = new TaskStore(join(f.native.root, 'execution-tasks.db'));
  cleanup.push(() => tasks.close());
  let requiredCapabilities: readonly string[] = ['ordinary_conversation', 'task_execution'];
  const resolve = () => {
    if (!isAuthSessionCurrent(f.native.auth)) throw Error('Revoked operator');
    return {
      binding: f.native.binding,
      agentProfile: f.native.first.reserved.agentProfile,
      taskRoot: f.native.taskRoot,
      requiredCapabilities,
    };
  };
  const createOwner = () =>
    new TelosWorkDelegation<'ordinary'>({
      workspaceKind: 'ordinary',
      work: f.work,
      events: f.native.events,
      tasks,
      workspaces: f.native.workspaces,
      qualifyOrdinarySettings: async () => resolve(),
      resolvePreparation: async () => resolve(),
      authorize: async () => {
        resolve();
      },
      assertBeforeApply: () => {
        resolve();
      },
    });
  return {
    native: f.native,
    canonical: f.canonical,
    db: f.db,
    actor: f.actor,
    get work() {
      return f.work;
    },
    leadConversationId,
    input,
    get tasks() {
      return tasks;
    },
    get delegation() {
      return createOwner();
    },
    restart: () => {
      f.restart();
      tasks.close();
      f.native.reopenStorage();
      tasks = new TaskStore(join(f.native.root, 'execution-tasks.db'));
    },
    unsupported: () => {
      requiredCapabilities = ['git_revision'];
    },
  };
}
it('delegates only the selected canonical child to one independent non-Git workspace, chat and real task without a turn', async () => {
  const f = await fixture(),
    before = f.native.events.listSessions().length;
  const receipt = await f.delegation.delegate(f.actor, f.input, f.native.signal.signal);
  expect(receipt).toMatchObject({
    state: 'chat_ready',
    execution: 'not_started',
    attempt: { childItemId: 'slice', turnCommandId: null },
  });
  expect(receipt.workerConversationId).not.toBe(f.leadConversationId);
  const worker = f.native.events.getSession(receipt.workerConversationId)!;
  const lead = f.native.events.getSession(f.leadConversationId)!;
  expect(worker.ordinaryWorkspaceId).toBeTruthy();
  expect(worker.ordinaryWorkspaceId).not.toBe(lead.ordinaryWorkspaceId);
  expect(worker.repositoryWorkspaceId).toBeUndefined();
  expect(f.native.events.listSessions()).toHaveLength(before + 1);
  expect(f.tasks.getTelosExecutionBinding(receipt.attempt.executionTaskId!)).toMatchObject({
    childItemId: 'slice',
    workerConversationId: receipt.workerConversationId,
  });
  expect(f.work.read('sibling', f.actor).attempts).toEqual([]);
  expect(f.work.read('sibling', f.actor).links).toEqual([]);
  expect(f.native.events.getOrdinaryInitialCommandId(receipt.workerConversationId)).toBeUndefined();
  expect(
    f.native.workspaces.getOrdinaryWorkspaceForConversation(receipt.workerConversationId)?.state,
  ).toBe('reserved');
  expect(f.native.forbidden).not.toHaveBeenCalled();
  expect(f.native.first.launch).not.toHaveBeenCalled();
});
it('concurrent duplicate and canonical/task-owner restart recover the exact original V2 child identities', async () => {
  const f = await fixture(),
    before = f.native.events.listSessions().length;
  const receipts = await Promise.all([
    f.delegation.delegate(f.actor, f.input, f.native.signal.signal),
    f.delegation.delegate(f.actor, f.input, f.native.signal.signal),
    f.delegation.delegate(
      f.actor,
      { ...structuredClone(f.input), requestId: randomUUID() },
      f.native.signal.signal,
    ),
  ]);
  expect(receipts[1]).toEqual(receipts[0]);
  expect(receipts[2]).toEqual(receipts[0]);
  f.restart();
  expect(await f.delegation.delegate(f.actor, f.input, f.native.signal.signal)).toEqual(
    receipts[0],
  );
  expect(f.native.events.listSessions()).toHaveLength(before + 1);
  expect(f.work.read('slice', f.actor).attempts).toHaveLength(1);
  expect(f.tasks.getTelosExecutionBinding(receipts[0].attempt.executionTaskId!)).toMatchObject({
    childItemId: 'slice',
  });
});
it('refuses unsupported requirements before the V2 exact-child attempt/allocation journal or any session/task effects', async () => {
  const f = await fixture(),
    before = f.native.events.listSessions().length;
  f.unsupported();
  const reserve = vi.spyOn(f.native.workspaces, 'reserveOrdinaryWorkspace');
  await expect(f.delegation.delegate(f.actor, f.input, f.native.signal.signal)).rejects.toThrow(
    'unsupported',
  );
  expect(reserve).not.toHaveBeenCalled();
  expect(f.native.events.listSessions()).toHaveLength(before);
  expect(f.work.read('slice', f.actor).attempts).toEqual([]);
  expect(f.db.prepare('SELECT count(*) AS n FROM telos_work_delegation_requests').get()).toEqual({
    n: 0,
  });
});

it('recovers the exact V2 worker after a lost committed ordinary preparation response and all owners reopen', async () => {
  const f = await fixture();
  const originalPrepare = f.native.events.prepareOrdinaryWorkspaceSession.bind(f.native.events);
  vi.spyOn(f.native.events, 'prepareOrdinaryWorkspaceSession').mockImplementationOnce((...args) => {
    originalPrepare(...args);
    throw Error('Injected lost V2 preparation response');
  });
  await expect(f.delegation.delegate(f.actor, f.input, f.native.signal.signal)).rejects.toThrow(
    'Injected lost V2 preparation response',
  );
  const intent = f.work.latestOrdinaryDelegationForHost('slice')!;
  const original = f.native.events.getOrdinaryWorkspaceSessionPreparation(
    intent.allocationOperationId,
  )!;
  expect(original.delegationAttemptId).toBe(intent.attemptId);
  const before = f.native.events.listSessions().length;
  f.restart();
  const reserve = vi.spyOn(f.native.workspaces, 'reserveOrdinaryWorkspace');
  const receipt = await f.delegation.delegate(f.actor, f.input, f.native.signal.signal);
  expect(receipt.workerConversationId).toBe(original.sessionId);
  expect(receipt.attempt.attemptId).toBe(intent.attemptId);
  expect(
    f.native.events.getOrdinaryWorkspaceSessionPreparation(intent.allocationOperationId),
  ).toEqual(original);
  expect(reserve).not.toHaveBeenCalled();
  expect(f.native.events.listSessions()).toHaveLength(before);
  expect(f.tasks.getTelosExecutionBinding(receipt.attempt.executionTaskId!)).toMatchObject({
    attemptId: intent.attemptId,
    workerConversationId: original.sessionId,
  });
  expect(f.native.first.launch).not.toHaveBeenCalled();
  expect(f.native.forbidden).not.toHaveBeenCalled();
});
it('requires explicit predecessor retry and retains earlier ordinary workers, output and attempt history', async () => {
  const f = await fixture();
  const first = await f.delegation.delegate(f.actor, f.input, f.native.signal.signal);
  const retained = f.canonical.artifacts.save({
    itemId: 'slice',
    filename: 'first-panel-plan.md',
    title: 'First retained panel plan',
    bytes: Buffer.from('Original worker panel measurements'),
    sessionId: first.workerConversationId,
    requestId: 'first-worker-plan',
  });
  const contextSelection = reviewTelosWorkRoleContext({
    work: f.work,
    artifacts: f.canonical.artifacts,
    actor: f.actor,
    itemId: 'slice',
    role: 'worker',
    selectedSourceSnapshotIds: [],
    selectedArtifactRefs: [],
  });
  const retry = {
    ...structuredClone(f.input),
    requestId: randomUUID(),
    mode: 'retry' as const,
    predecessorAttemptId: first.attempt.attemptId,
    expectedRevision: contextSelection.brief.revision,
    contextSelection,
  };
  await expect(
    f.delegation.delegate(
      f.actor,
      { ...retry, predecessorAttemptId: null },
      f.native.signal.signal,
    ),
  ).rejects.toThrow();
  const second = await f.delegation.delegate(f.actor, retry, f.native.signal.signal);
  expect(second.workerConversationId).not.toBe(first.workerConversationId);
  expect(f.native.events.getSession(first.workerConversationId)?.ordinaryWorkspaceId).not.toBe(
    f.native.events.getSession(second.workerConversationId)?.ordinaryWorkspaceId,
  );
  const view = f.work.read('slice', f.actor);
  expect(view.attempts).toHaveLength(2);
  expect(view.attempts[1].predecessorAttemptId).toBe(first.attempt.attemptId);
  expect(view.links.map((link) => link.conversation.conversationId)).toEqual(
    expect.arrayContaining([first.workerConversationId, second.workerConversationId]),
  );
  expect(f.tasks.getTelosExecutionBinding(first.attempt.executionTaskId!)).toMatchObject({
    workerConversationId: first.workerConversationId,
  });
  expect(f.canonical.artifacts.read(retained.id, retained.revision).bytes.toString()).toBe(
    'Original worker panel measurements',
  );
  expect(f.work.read('sibling', f.actor).attempts).toEqual([]);
});

it('retains a cancelled V2 reservation and recovers only its original allocation under renewed request authority', async () => {
  const f = await fixture(),
    before = f.native.events.listSessions().length;
  const originalReserve = f.native.workspaces.reserveOrdinaryWorkspace.bind(f.native.workspaces);
  let reserved: Awaited<ReturnType<typeof originalReserve>> | undefined;
  vi.spyOn(f.native.workspaces, 'reserveOrdinaryWorkspace').mockImplementationOnce(
    async (input) => {
      reserved = await originalReserve(input);
      f.native.signal.abort();
      return reserved;
    },
  );
  await expect(f.delegation.delegate(f.actor, f.input, f.native.signal.signal)).rejects.toThrow();
  expect(reserved).toBeDefined();
  const intent = f.work.latestOrdinaryDelegationForHost('slice')!;
  expect(f.work.attemptForHost(intent.attemptId)?.state).toBe('allocation_uncertain');
  expect(f.native.events.getSession(reserved!.conversationId)).toBeNull();
  expect(f.native.events.listSessions()).toHaveLength(before);
  f.restart();
  const receipt = await f.delegation.delegate(f.actor, f.input, new AbortController().signal);
  expect(receipt.workerConversationId).toBe(reserved!.conversationId);
  expect(f.native.events.getSession(receipt.workerConversationId)?.ordinaryWorkspaceId).toBe(
    reserved!.id,
  );
  expect(f.native.events.listSessions()).toHaveLength(before + 1);
  expect(f.work.read('slice', f.actor).attempts).toHaveLength(1);
  expect(f.native.first.launch).not.toHaveBeenCalled();
});
it('refuses revoked actual operator authority before retaining a V2 child intent or allocating', async () => {
  const f = await fixture(),
    before = f.native.events.listSessions().length;
  const reserve = vi.spyOn(f.native.workspaces, 'reserveOrdinaryWorkspace');
  revokeAuthSession(f.native.auth);
  await expect(f.delegation.delegate(f.actor, f.input, f.native.signal.signal)).rejects.toThrow(
    'Revoked operator',
  );
  expect(reserve).not.toHaveBeenCalled();
  expect(f.native.events.listSessions()).toHaveLength(before);
  expect(f.db.prepare('SELECT count(*) AS n FROM telos_work_delegation_requests').get()).toEqual({
    n: 0,
  });
});

it('rejects invalid thinking before a V2 child attempt or reservation using the same real account authority', async () => {
  const f = await fixture(),
    before = f.native.events.listSessions().length;
  f.input.settings.selection.thinking = 'unavailable';
  const reserve = vi.spyOn(f.native.workspaces, 'reserveOrdinaryWorkspace');
  await expect(f.delegation.delegate(f.actor, f.input, f.native.signal.signal)).rejects.toThrow(
    'Thinking level unavailable',
  );
  expect(reserve).not.toHaveBeenCalled();
  expect(f.native.events.listSessions()).toHaveLength(before);
  expect(f.db.prepare('SELECT count(*) AS n FROM telos_work_delegation_requests').get()).toEqual({
    n: 0,
  });
});
it('refuses a hidden original V2 worker on replay while retaining its task and workspace identity', async () => {
  const f = await fixture();
  const receipt = await f.delegation.delegate(f.actor, f.input, f.native.signal.signal);
  const original = f.native.events.getSession(receipt.workerConversationId)!;
  f.native.events.hideSession(receipt.workerConversationId);
  await expect(f.delegation.delegate(f.actor, f.input, f.native.signal.signal)).rejects.toThrow(
    'Original available ordinary worker custody required',
  );
  expect(f.tasks.getTelosExecutionBinding(receipt.attempt.executionTaskId!)).toMatchObject({
    workerConversationId: receipt.workerConversationId,
  });
  expect(
    f.native.workspaces.getOrdinaryWorkspaceForConversation(receipt.workerConversationId)?.id,
  ).toBe(original.ordinaryWorkspaceId);
  expect(f.work.read('slice', f.actor).attempts).toHaveLength(1);
});
it('fails closed when the existing task-binding inventory cannot be read and preserves the original ready attempt', async () => {
  const f = await fixture();
  const receipt = await f.delegation.delegate(f.actor, f.input, f.native.signal.signal);
  const spy = vi.spyOn(f.tasks, 'getTelosExecutionBinding').mockImplementation(() => {
    throw Error('Task inventory unavailable');
  });
  await expect(f.delegation.delegate(f.actor, f.input, f.native.signal.signal)).rejects.toThrow(
    'Task inventory unavailable',
  );
  spy.mockRestore();
  expect(f.tasks.getTelosExecutionBinding(receipt.attempt.executionTaskId!)).toMatchObject({
    workerConversationId: receipt.workerConversationId,
  });
  expect(f.work.attemptForHost(receipt.attempt.attemptId)?.state).toBe('chat_ready');
  expect(
    f.native.workspaces.getOrdinaryWorkspaceForConversation(receipt.workerConversationId)?.state,
  ).toBe('reserved');
});

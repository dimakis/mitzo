import { resolveTelosWorkCommandScope } from '../telos-work-command-scope.js';
import { loadAccountProfiles } from '../account-profiles.js';
import { mkdirSync, renameSync, symlinkSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
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
  const resolve = (settings = input.settings) => {
    if (!isAuthSessionCurrent(f.native.auth)) throw Error('Revoked operator');
    return {
      binding: loadAccountProfiles().resolve(
        settings.binding.account.accountId,
        settings.selection.model,
      ),
      agentProfile: f.native.first.reserved.agentProfile,
      taskRoot:
        settings.binding.account.accountId === f.native.binding.accountId
          ? f.native.taskRoot
          : join(f.native.root, 'alternate-tasks'),
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
      qualifyOrdinarySettings: async (scope) => resolve(scope.input.settings),
      resolvePreparation: async (scope) => resolve(scope.settings),
      authorize: async (scope) => {
        resolve(scope.settings);
      },
      assertBeforeApply: (scope) => {
        resolve(scope.settings);
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
  const scope = () =>
    resolveTelosWorkCommandScope(
      { events: f.native.events, tasks: f.tasks, work: () => f.work },
      original.sessionId,
      f.native.binding,
    );
  expect(scope).toThrow(/incomplete|delegat/i);
  const before = f.native.events.listSessions().length;
  f.restart();
  expect(scope).toThrow(/incomplete|delegat/i);
  const reserve = vi.spyOn(f.native.workspaces, 'reserveOrdinaryWorkspace');
  const receipt = await f.delegation.delegate(f.actor, f.input, f.native.signal.signal);
  expect(receipt.workerConversationId).toBe(original.sessionId);
  expect(receipt.attempt.attemptId).toBe(intent.attemptId);
  expect(scope()).toEqual({
    currentTaskId: receipt.attempt.executionTaskId,
    goalId: receipt.attempt.executionTaskId,
  });
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

it.each([
  'missing_binding',
  'empty_restored_database',
  'mismatched_binding',
  'mismatched_task_session',
] as const)(
  'refuses committed replay with readable %s inventory without creating a replacement task',
  async (state) => {
    const f = await fixture();
    const receipt = await f.delegation.delegate(f.actor, f.input, f.native.signal.signal);
    const retained = f.canonical.artifacts.save({
      itemId: 'slice',
      filename: 'original-task-plan.md',
      title: 'Original task plan',
      bytes: Buffer.from('Retain this original output'),
      sessionId: receipt.workerConversationId,
    });
    const originalWorkspace = f.native.workspaces.getOrdinaryWorkspaceForConversation(
      receipt.workerConversationId,
    )!;
    const db = new Database(join(f.native.root, 'execution-tasks.db'));
    try {
      if (state === 'missing_binding' || state === 'empty_restored_database')
        db.prepare('DELETE FROM task_telos_execution_bindings WHERE task_id=?').run(
          receipt.attempt.executionTaskId,
        );
      if (state === 'empty_restored_database')
        db.prepare('DELETE FROM tasks WHERE id=?').run(receipt.attempt.executionTaskId);
      if (state === 'mismatched_binding')
        db.prepare(
          "UPDATE task_telos_execution_bindings SET worker_conversation_id='foreign-worker' WHERE task_id=?",
        ).run(receipt.attempt.executionTaskId);
      if (state === 'mismatched_task_session')
        db.prepare("UPDATE tasks SET session_id='foreign-worker' WHERE id=?").run(
          receipt.attempt.executionTaskId,
        );
      const before = db.prepare('SELECT count(*) AS n FROM tasks').get();
      f.restart();
      const outcome = await f.delegation.delegate(f.actor, f.input, f.native.signal.signal).then(
        () => 'accepted',
        () => 'rejected',
      );
      expect({ outcome, taskRows: db.prepare('SELECT count(*) AS n FROM tasks').get() }).toEqual({
        outcome: 'rejected',
        taskRows: before,
      });
      expect(f.work.attemptForHost(receipt.attempt.attemptId)).toEqual(receipt.attempt);
      expect(
        f.native.workspaces.getOrdinaryWorkspaceForConversation(receipt.workerConversationId),
      ).toEqual(originalWorkspace);
      expect(f.canonical.artifacts.read(retained.id, retained.revision).bytes.toString()).toBe(
        'Retain this original output',
      );
      expect(
        f.native.events.getOrdinaryInitialCommandId(receipt.workerConversationId),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  },
);
it('requires the owning original-task verifier even when the canonical delegation receipt is already committed', async () => {
  const f = await fixture();
  const receipt = await f.delegation.delegate(f.actor, f.input, f.native.signal.signal);
  const intent = f.work.latestOrdinaryDelegationForHost('slice')!;
  expect(() =>
    f.work.completeDelegation(
      intent,
      f.actor,
      {
        workerConversationId: receipt.workerConversationId,
        executionTaskId: receipt.attempt.executionTaskId!,
      },
      () => false,
      () => {},
    ),
  ).toThrow();
  expect(f.work.attemptForHost(intent.attemptId)).toEqual(receipt.attempt);
});

it.each([
  'claiming',
  'replaced-directory',
  'symlink-directory',
  'replaced-root',
  'symlink-root',
] as const)(
  'refuses committed delegation replay with %s while retaining original allocation',
  async (damage) => {
    const f = await fixture();
    const original = await f.delegation.delegate(f.actor, f.input, f.native.signal.signal);
    const conversationId = original.workerConversationId;
    const record = f.native.workspaces.getOrdinaryWorkspaceForConversation(conversationId)!;
    const sessions = f.native.events.listSessions().length;
    if (damage === 'claiming') {
      const db = new Database(join(f.native.root, 'workspace-owner', 'workspaces.db'));
      try {
        db.prepare('UPDATE ordinary_workspaces SET record=? WHERE id=?').run(
          JSON.stringify({ ...record, state: 'claiming' }),
          record.id,
        );
      } finally {
        db.close();
      }
    } else if (damage.endsWith('directory')) {
      await f.native.workspaces.claimOrdinaryWorkspace({
        id: record.id,
        conversationId,
        binding: f.native.binding,
        taskRoot: f.native.taskRoot,
        signal: f.native.signal.signal,
      });
      renameSync(record.directory, record.directory + '-retained');
      if (damage === 'replaced-directory') mkdirSync(record.directory, { mode: 0o700 });
      else symlinkSync(record.directory + '-retained', record.directory);
    } else {
      renameSync(f.native.taskRoot, f.native.taskRoot + '-retained');
      if (damage === 'replaced-root') mkdirSync(f.native.taskRoot, { mode: 0o700 });
      else symlinkSync(f.native.taskRoot + '-retained', f.native.taskRoot);
    }
    await expect(f.delegation.delegate(f.actor, f.input, f.native.signal.signal)).rejects.toThrow();
    expect(f.native.events.listSessions()).toHaveLength(sessions);
    expect(f.native.workspaces.getOrdinaryWorkspaceForConversation(conversationId)?.id).toBe(
      record.id,
    );
    expect(f.native.first.launch).not.toHaveBeenCalled();
    expect(
      f.tasks.getTelosExecutionBinding(original.attempt.executionTaskId!)?.workerConversationId,
    ).toBe(conversationId);
    expect(f.work.read('slice', f.actor).attempts).toHaveLength(1);
  },
);

it('replays the same claimed delegation workspace while preserving legitimate files', async () => {
  const f = await fixture();
  const original = await f.delegation.delegate(f.actor, f.input, f.native.signal.signal);
  const conversationId = original.workerConversationId;
  const record = f.native.workspaces.getOrdinaryWorkspaceForConversation(conversationId)!;
  await f.native.workspaces.claimOrdinaryWorkspace({
    id: record.id,
    conversationId,
    binding: f.native.binding,
    taskRoot: f.native.taskRoot,
    signal: f.native.signal.signal,
  });
  const file = join(record.directory, 'retained-plan.txt');
  writeFileSync(file, 'Studio plan');
  const identity = statSync(record.directory).ino;
  expect(await f.delegation.delegate(f.actor, f.input, f.native.signal.signal)).toEqual(original);
  expect(statSync(record.directory).ino).toBe(identity);
  expect(readFileSync(file, 'utf8')).toBe('Studio plan');
});
it.each(['abort', 'revoke'] as const)(
  'rechecks delegation authority after custody readiness: %s',
  async (change) => {
    const f = await fixture();
    const original = await f.delegation.delegate(f.actor, f.input, f.native.signal.signal);
    const conversationId = original.workerConversationId;
    const before = f.native.events.listSessions().length;
    const revalidate = f.native.workspaces.revalidateOrdinaryWorkspace.bind(f.native.workspaces);
    vi.spyOn(f.native.workspaces, 'revalidateOrdinaryWorkspace').mockImplementationOnce(
      async (input) => {
        const result = await revalidate(input);
        if (change === 'abort') f.native.signal.abort();
        else revokeAuthSession(f.native.auth);
        return result;
      },
    );
    await expect(f.delegation.delegate(f.actor, f.input, f.native.signal.signal)).rejects.toThrow();
    expect(f.native.events.listSessions()).toHaveLength(before);
    expect(f.native.workspaces.getOrdinaryWorkspaceForConversation(conversationId)).toBeDefined();
  },
);

it('recovers the canonical default-start attempt when a new request selects another genuinely valid account, model and task root', async () => {
  const f = await fixture();
  const original = await f.delegation.delegate(f.actor, f.input, f.native.signal.signal);
  const profilesPath = process.env.MITZO_ACCOUNT_PROFILES_FILE!;
  const configured = JSON.parse(readFileSync(profilesPath, 'utf8'));
  configured.push({
    ...configured[0],
    id: 'ordinary-alternate',
    label: 'Alternate offline account',
    models: [
      {
        id: 'fixture-alternate-model',
        label: 'Offline alternate model',
        reasoningEfforts: ['low'],
      },
    ],
  });
  writeFileSync(profilesPath, JSON.stringify(configured));
  const binding = loadAccountProfiles().resolve('ordinary-alternate', 'fixture-alternate-model');
  const prepared = await f.native.workspaces.prepareOrdinaryWorkspace({
    binding,
    selection: {
      runOn: 'local',
      runtime: {
        account: {
          accountId: binding.accountId,
          provider: 'openai-codex',
          profileRevision: binding.profileRevision,
        },
        harness: 'codex',
        targetId: f.input.settings.binding.execution.targetId,
      },
    },
    signal: f.native.signal.signal,
  });
  const taskRoot = join(f.native.root, 'alternate-tasks');
  mkdirSync(taskRoot, { mode: 0o700 });
  const settings = {
    ...structuredClone(f.input.settings),
    binding: prepared.runtimeBinding,
    workspace: { kind: 'ordinary' as const, preparationId: prepared.preparationId },
    selection: { ...f.input.settings.selection, model: binding.model },
  };
  // Prove the changed incoming selection is genuinely eligible, not malformed intent.
  await f.native.workspaces.qualifyOrdinaryWorkspace({
    preparationId: prepared.preparationId,
    binding,
    settings,
    agentProfile: f.native.first.reserved.agentProfile,
    signal: f.native.signal.signal,
  });
  const sessions = f.native.events.listSessions().length;
  const reserve = vi.spyOn(f.native.workspaces, 'reserveOrdinaryWorkspace');
  // Exact command identity still forbids changing settings; only a distinct
  // default-start alias may recover the already canonical attempt.
  await expect(
    f.delegation.delegate(
      f.actor,
      { ...structuredClone(f.input), settings },
      f.native.signal.signal,
    ),
  ).rejects.toThrow();
  const requestId = randomUUID();
  expect(
    await f.delegation.delegate(
      f.actor,
      { ...structuredClone(f.input), requestId, settings },
      f.native.signal.signal,
    ),
  ).toEqual(original);
  expect(f.native.events.listSessions()).toHaveLength(sessions);
  expect(f.tasks.getTree()).toHaveLength(1);
  expect(reserve).not.toHaveBeenCalled();
  expect(f.work.ordinaryDelegationRequestForHost(requestId, f.actor)?.input.settings).toEqual(
    f.input.settings,
  );
  expect(
    f.native.workspaces.getOrdinaryWorkspaceForConversation(original.workerConversationId)?.binding,
  ).toEqual(f.native.binding);
});

it.each(['preparation-attempt', 'work-allocation'] as const)(
  'refuses changed V2 %s authority before any command without changing the task or receipt',
  async (damage) => {
    const f = await fixture(),
      receipt = await f.delegation.delegate(f.actor, f.input, f.native.signal.signal);
    const original = f.native.events.getOrdinaryWorkspaceSessionPreparationForConversation(
      receipt.workerConversationId,
    )!;
    const before = f.tasks.getTree();
    if (damage === 'preparation-attempt') {
      const db = new Database(join(f.native.root, 'events.db'));
      try {
        db.prepare('UPDATE ordinary_session_preparations SET receipt=? WHERE operation_id=?').run(
          JSON.stringify({ ...original, delegationAttemptId: randomUUID() }),
          original.allocationOperationId,
        );
      } finally {
        db.close();
      }
    } else
      f.db
        .prepare(
          "UPDATE telos_work_attempts SET data=json_set(data,'$.allocationReceiptId',?) WHERE attempt_id=?",
        )
        .run(randomUUID(), receipt.attempt.attemptId);
    expect(() =>
      resolveTelosWorkCommandScope(
        { events: f.native.events, tasks: f.tasks, work: () => f.work },
        receipt.workerConversationId,
        f.native.binding,
      ),
    ).toThrow(/delegat|authority/i);
    expect(f.tasks.getTree()).toEqual(before);
    expect(
      f.native.events.getOrdinaryInitialCommandId(receipt.workerConversationId),
    ).toBeUndefined();
    expect(f.native.first.launch).not.toHaveBeenCalled();
  },
);

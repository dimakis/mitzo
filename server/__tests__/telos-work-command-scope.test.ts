import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { TaskStore } from '../task-store.js';
import { TelosWorkStore } from '../telos-work-store.js';
import {
  retainTelosWorkRoleContext,
  resolveTelosWorkRoleContext,
} from '../telos-work-role-context.js';
import { resolveTelosWorkCommandScope } from '../telos-work-command-scope.js';
import { handleTaskComplete, handleTaskStatus } from '../task-tools.js';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture(delegation = true, withRole = true, marker?: string) {
  const root = mkdtempSync(join(tmpdir(), 'telos-command-scope-'));
  let events = new EventStore(join(root, 'events.db'));
  let tasks = new TaskStore(join(root, 'tasks.db'));
  const path = join(root, 'work.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT,summary TEXT,updated_at TEXT);
    INSERT INTO items VALUES('outcome',NULL,'Outcome','original');
    INSERT INTO items VALUES('child','outcome','Slice one','original');`);
  db.close();
  const open = () =>
    new TelosWorkStore(path, { ordinaryConversation: (id) => !!events.getSession(id) });
  let work = open();
  cleanups.push(() => {
    work.close();
    tasks.close();
    events.close();
    rmSync(root, { recursive: true, force: true });
  });
  const actor = { kind: 'operator' as const, id: 'operator' };
  events.upsertSession({ sessionId: 'lead' });
  const command = (itemId: string, input: object) =>
    work.execute(
      {
        itemId,
        requestId: randomUUID(),
        expectedRevision: work.read(itemId, actor).revision,
        ...input,
      },
      actor,
    );
  command('outcome', { operation: 'classify', kind: 'outcome' });
  command('child', { operation: 'classify', kind: 'work_item' });
  command('outcome', {
    operation: 'link',
    role: 'lead',
    conversation: { namespace: 'mitzo', conversationId: 'lead' },
  });
  command('outcome', {
    operation: 'assign',
    role: 'lead',
    conversationId: 'lead',
    expectedAssignmentRevision: 0,
  });
  const account = {
    accountId: 'offline',
    accountLabel: 'Offline',
    provider: 'openai-codex' as const,
    model: 'offline-fixture',
    profileRevision: 'r1',
  };
  const binding = {
    version: 2 as const,
    account: {
      accountId: account.accountId,
      provider: account.provider,
      profileRevision: account.profileRevision,
    },
    harness: { implementation: 'codex' as const },
    execution: { location: 'local' as const, targetId: 'offline', targetRevision: 'r1' },
  };
  const definition = {
    name: 'Offline',
    descriptor: 'Offline',
    role: 'agent' as const,
    instructions: 'Offline',
    expectedOutput: 'Evidence',
    acceptanceCriteria: ['Evidence'],
    modelPolicyRole: 'agent' as const,
  };
  const profile = {
    profileId: 'offline',
    revision: 1,
    definition,
    contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
  };
  const settings = {
    binding,
    repositoryWorkspaceId: randomUUID(),
    selection: {
      version: 1 as const,
      agent: { profileId: profile.profileId, revision: profile.revision },
      context: { source: 'none' as const, revision: null },
      permission: { mode: 'agent' as const, revision: 0 },
      model: account.model,
      thinking: null,
    },
  };
  const selected = {
    version: 1 as const,
    itemId: 'child',
    role: 'worker' as const,
    leadConversationId: 'lead',
    brief: {
      revision: work.read('child', actor).revision,
      text: 'Reviewed child',
      sha256: createHash('sha256').update('Reviewed child').digest('hex'),
    },
    parentCriteria: [],
    overallGoal: {
      itemId: 'outcome',
      revision: work.read('outcome', actor).revision,
      text: 'Outcome',
    },
    sources: [],
    artifacts: [],
  };
  const retained = delegation
    ? work.prepareDelegation(
        {
          requestId: 'start',
          leadItemId: 'outcome',
          childItemId: 'child',
          leadConversationId: 'lead',
          expectedRevision: selected.brief.revision,
          mode: 'start',
          predecessorAttemptId: null,
          settings,
          contextSelection: selected,
        },
        actor,
      )
    : null;
  const operationId = retained?.intent.allocationOperationId ?? randomUUID();
  const meta = {
    sessionId: 'worker',
    repositoryWorkspaceId: operationId,
    cwd: root,
    accountBinding: account,
    agentProfile: profile,
    selectedModel: account.model,
    reasoningEffort: null,
    mode: 'agent' as const,
  };
  events.prepareOrdinarySession(meta, {
    allocationOperationId: operationId,
    preparationFingerprint: 'a'.repeat(64),
    settings: { ...settings, repositoryWorkspaceId: operationId },
    ...(retained ? { delegationAttemptId: marker ?? retained.intent.attemptId } : {}),
  });
  if (withRole) retainTelosWorkRoleContext(events, 'worker', account, selected);
  const lazyWork = vi.fn(() => work);
  const owners = () => ({ events, tasks, work: lazyWork });
  let taskId: string | undefined;
  const mapTask = () => {
    const intent = retained!.intent;
    taskId = tasks.createOrRecoverTelosExecutionTask(
      { title: 'Reviewed child' },
      {
        attemptId: intent.attemptId,
        childItemId: 'child',
        leadConversationId: 'lead',
        workerConversationId: 'worker',
        contextSnapshotId: intent.contextSnapshotId,
        contextHash: createHash('sha256')
          .update(JSON.stringify(resolveTelosWorkRoleContext(events, 'worker', account)))
          .digest('hex'),
      },
    ).id;
    return taskId;
  };
  return {
    account,
    meta,
    binding,
    settings,
    lazyWork,
    owners,
    mapTask,
    get events() {
      return events;
    },
    get tasks() {
      return tasks;
    },
    get work() {
      return work;
    },
    complete() {
      const id = taskId ?? mapTask();
      work.completeDelegation(
        retained!.intent,
        actor,
        { workerConversationId: 'worker', executionTaskId: id },
        () => true,
        () => {},
      );
      return id;
    },
    admit(id: string, continuation = false) {
      const command = {
        clientMsgId: id,
        requestFingerprint: `offline:${id}`,
        selection: settings.selection,
        payload: { text: 'Explicit user command', systemPrompt: 'Offline' },
      };
      const scope = resolveTelosWorkCommandScope(owners(), 'worker', account);
      if (continuation) events.admitOrdinaryLocalContinuation(meta, binding, command);
      else events.admitPreparedOrdinaryCommand(operationId, meta, binding, command);
      return scope;
    },
    reopen() {
      work.close();
      tasks.close();
      events.close();
      events = new EventStore(join(root, 'events.db'));
      tasks = new TaskStore(join(root, 'tasks.db'));
      work = open();
    },
    corruptMap() {
      const writer = new Database(join(root, 'tasks.db'));
      writer
        .prepare('UPDATE task_telos_execution_bindings SET context_hash=? WHERE task_id=?')
        .run('0'.repeat(64), taskId);
      writer.close();
    },
    corruptAllocation() {
      const writer = new Database(path);
      writer
        .prepare(
          "UPDATE telos_work_attempts SET data=json_set(data,'$.allocationReceiptId','another-allocation') WHERE attempt_id=?",
        )
        .run(retained!.intent.attemptId);
      writer.close();
    },
  };
}

it('keeps unbound ordinary chats lazy and preserves S4 standalone worker admission', () => {
  const f = fixture(false);
  f.events.upsertSession({ sessionId: 'legacy' });
  expect(resolveTelosWorkCommandScope(f.owners(), 'legacy', undefined)).toBeNull();
  expect(f.lazyWork).not.toHaveBeenCalled();
  expect(f.admit('s4-command')).toBeNull();
  expect(f.events.getSendCommand('s4-command')?.sessionId).toBe('worker');
});

it('refuses incomplete S5 linkage before real ordinary command admission without repairing it', () => {
  const f = fixture();
  expect(() => f.admit('missing-map')).toThrow(/incomplete|delegat/i);
  expect(f.events.getSendCommand('missing-map')).toBeUndefined();
  const task = f.mapTask();
  expect(() => f.admit('missing-work-link')).toThrow(/authority/i);
  expect(f.events.getSendCommand('missing-work-link')).toBeUndefined();
  expect(f.work.executionTaskBinding(task, 'worker')).toBeNull();
});

it('refuses a marked S5 allocation before role retention or task linkage, including after restart', () => {
  const f = fixture(true, false);
  f.reopen();
  expect(() => f.admit('crash-before-role')).toThrow(/incomplete|delegat/i);
  expect(f.events.getSendCommand('crash-before-role')).toBeUndefined();
  expect(f.events.getSessionEvents('worker')).toEqual([]);
});

it('refuses a delegation marker for another attempt or allocation before command admission', () => {
  const mismatch = fixture(true, true, 'another-attempt');
  mismatch.complete();
  expect(() => mismatch.admit('wrong-attempt-marker')).toThrow(/delegat|authority/i);
  expect(mismatch.events.getSendCommand('wrong-attempt-marker')).toBeUndefined();
  const f = fixture();
  f.complete();
  f.corruptAllocation();
  expect(() => f.admit('wrong-allocation-marker')).toThrow(/delegat|authority/i);
  expect(f.events.getSendCommand('wrong-allocation-marker')).toBeUndefined();
});

it('proves exact first and continuation scope from both durable owners across restart', () => {
  const f = fixture();
  const taskId = f.complete();
  const before = f.events.getSessionEvents('worker');
  expect(f.admit('first')).toEqual({ currentTaskId: taskId, goalId: taskId });
  f.events.claimOrdinaryLocalCommandDispatch('first');
  f.events.completeOrdinaryLocalCommand('first');
  f.reopen();
  expect(f.admit('next', true)).toEqual({ currentTaskId: taskId, goalId: taskId });
  expect(f.events.getSessionEvents('worker')).toEqual(before);
  expect(f.events.getSession('worker')?.accountBinding).toEqual(f.account);
});

it('refuses mismatched durable mapping or account without admitting a command', () => {
  const f = fixture();
  f.complete();
  expect(() =>
    resolveTelosWorkCommandScope(f.owners(), 'worker', { ...f.account, accountId: 'other' }),
  ).toThrow();
  f.corruptMap();
  expect(() => f.admit('wrong-map')).toThrow();
  expect(f.events.getSendCommand('wrong-map')).toBeUndefined();
});

it('uses the proven worker task for TaskStatus and leaves TaskComplete pending independent review', () => {
  const f = fixture();
  const taskId = f.complete();
  const unrelated = f.tasks.create({ title: 'Unrelated outcome task' });
  const scope = resolveTelosWorkCommandScope(f.owners(), 'worker', f.account)!;
  expect(handleTaskStatus(f.tasks, scope.currentTaskId)).toContain('Reviewed child');
  expect(handleTaskStatus(f.tasks, scope.currentTaskId)).not.toContain('Unrelated outcome');
  expect(handleTaskComplete(f.tasks, scope.currentTaskId, 'Retained result evidence')).toContain(
    'pending_review',
  );
  expect(f.tasks.get(taskId)?.status).toBe('pending_review');
  expect(f.tasks.get(unrelated.id)?.status).toBe('pending');
});

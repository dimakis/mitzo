import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TelosWorkDelegationInput } from '@mitzo/protocol';
import { TelosWorkStore } from '../telos-work-store.js';
import { TaskStore } from '../task-store.js';
import { isAvailableTelosWorkConversation } from '../telos-work-conversation.js';
import {
  resolveTelosWorkRoleContext,
  retainTelosWorkRoleContext,
  TelosWorkRoleContextSelectionSchema,
} from '../telos-work-role-context.js';
import { TelosWorkDelegation } from '../telos-work-delegation.js';
import { createJoiningFixture, cleanupJoiningFixtures } from './fixtures/collaboration-joining.js';

const cleanups: (() => void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  await cleanupJoiningFixtures();
});

// Real ordinary preparation, independent Git source custody and all three SQLite
// owners. Account/source authorization is deterministic and makes no model calls.
async function fixture() {
  const ordinary = await createJoiningFixture();
  const prepared = await ordinary.resolvePreparation();
  const lead = await ordinary.workspaces.prepareOrdinarySession(
    {
      ...prepared,
      allocationOperationId: randomUUID(),
      id: ordinary.input.settings.repositoryWorkspaceId,
      settings: ordinary.input.settings,
      signal: ordinary.signal,
    },
    ordinary.store,
  );
  const root = mkdtempSync(join(tmpdir(), 'telos-delegation-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'telos.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT,summary TEXT,updated_at TEXT);
    INSERT INTO items VALUES('outcome',NULL,'Outcome','original');
    INSERT INTO items VALUES('slice','outcome','Slice one','original');
    INSERT INTO items VALUES('sibling','outcome','Slice two','original');`);
  db.close();
  const actor = { kind: 'operator' as const, id: 'operator' };
  const open = () =>
    new TelosWorkStore(path, {
      ordinaryConversation: (id) => isAvailableTelosWorkConversation(ordinary.store.getSession(id)),
    });
  let work = open();
  let tasks = new TaskStore(join(root, 'tasks.db'));
  cleanups.push(() => {
    work.close();
    tasks.close();
  });
  const command = (itemId: string, fields: Record<string, unknown>) =>
    work.execute(
      {
        itemId,
        requestId: randomUUID(),
        expectedRevision: work.read(itemId, actor).revision,
        ...fields,
      },
      actor,
    );
  command('outcome', { operation: 'classify', kind: 'outcome' });
  command('slice', { operation: 'classify', kind: 'work_item' });
  command('sibling', { operation: 'classify', kind: 'work_item' });
  command('outcome', {
    operation: 'link',
    role: 'lead',
    conversation: {
      namespace: 'mitzo',
      conversationId: lead.receipt.sessionId,
    },
  });
  command('outcome', {
    operation: 'assign',
    role: 'lead',
    conversationId: lead.receipt.sessionId,
    expectedAssignmentRevision: 0,
  });
  const brief = JSON.stringify({
    summary: 'Slice one',
    intent: 'Only the selected slice',
    rationale: 'Independent evidence',
    acceptanceCriteria: ['Exact worker'],
    taskHint: 'Inspect',
  });
  const context = {
    version: 1 as const,
    itemId: 'slice',
    role: 'worker' as const,
    brief: {
      revision: work.read('slice', actor).revision,
      text: brief,
      sha256: createHash('sha256').update(brief).digest('hex'),
    },
    parentCriteria: [
      {
        itemId: 'outcome',
        revision: work.read('outcome', actor).revision,
        criteria: ['Outcome evidence'],
      },
    ],
    overallGoal: {
      itemId: 'outcome',
      revision: work.read('outcome', actor).revision,
      text: 'Outcome',
    },
    sources: [],
    artifacts: [],
    leadConversationId: lead.receipt.sessionId,
  };
  const leadContext = {
    ...context,
    itemId: 'outcome',
    role: 'lead' as const,
    parentCriteria: [],
    leadConversationId: undefined,
  };
  retainTelosWorkRoleContext(ordinary.store, lead.receipt.sessionId, prepared.binding, leadContext);
  let authorized = true;
  const assertCurrent = () => {
    if (!authorized) throw new Error('Authority revoked');
  };
  const authorize = vi.fn(async () => {
    assertCurrent();
  });
  const assertBeforeApply = vi.fn(() => {
    assertCurrent();
  });
  const resolvePreparation = vi.fn(async () => prepared);
  const input: TelosWorkDelegationInput = {
    requestId: randomUUID(),
    leadItemId: 'outcome',
    childItemId: 'slice',
    leadConversationId: lead.receipt.sessionId,
    expectedRevision: work.read('slice', actor).revision,
    mode: 'start',
    predecessorAttemptId: null,
    settings: structuredClone(ordinary.input.settings),
    contextSelection: context,
  };
  const owner = () =>
    new TelosWorkDelegation({
      work,
      events: ordinary.store,
      tasks,
      workspaces: ordinary.workspaces,
      authorize,
      resolvePreparation,
      assertBeforeApply,
    });
  return {
    ordinary,
    input,
    actor,
    owner,
    authorize,
    assertBeforeApply,
    resolvePreparation,
    command,
    lead: lead.receipt,
    get work() {
      return work;
    },
    get tasks() {
      return tasks;
    },
    revoke() {
      authorized = false;
    },
    changeChildRecord() {
      const writer = new Database(path);
      try {
        writer.prepare("UPDATE items SET summary='Changed canonical brief' WHERE id='slice'").run();
      } finally {
        writer.close();
      }
    },
    corruptWorkerProof(sessionId: string, kind: 'account' | 'target' | 'workspace' | 'missing') {
      const writer = new Database(join(dirname(prepared.taskRoot), 'events.db'));
      try {
        if (kind === 'missing') {
          const first = ordinary.store.getOrdinaryInitialCommandId(sessionId)!;
          writer
            .prepare('UPDATE send_commands SET ordinary_admission=NULL WHERE client_msg_id=?')
            .run(first);
        } else if (kind === 'account') {
          writer
            .prepare(
              "UPDATE sessions SET account_binding=json_set(account_binding,'$.accountId','another-account') WHERE session_id=?",
            )
            .run(sessionId);
        } else if (kind === 'target') {
          writer
            .prepare(
              "UPDATE sessions SET runtime_binding=json_set(runtime_binding,'$.execution.targetId','another-target') WHERE session_id=?",
            )
            .run(sessionId);
        } else {
          writer
            .prepare(
              "UPDATE sessions SET repository_workspace_id='another-workspace' WHERE session_id=?",
            )
            .run(sessionId);
        }
      } finally {
        writer.close();
      }
    },
    restore() {
      authorized = true;
    },
    reopen() {
      work.close();
      tasks.close();
      ordinary.reopen();
      work = open();
      tasks = new TaskStore(join(root, 'tasks.db'));
    },
  };
}

type WorkerCommandState =
  | 'first_reserved'
  | 'first_uncertain'
  | 'first_error'
  | 'later_reserved'
  | 'later_uncertain'
  | 'later_error'
  | 'previous_display';
function admitLaterSettings(
  f: Awaited<ReturnType<typeof fixture>>,
  workerId: string,
  state?: WorkerCommandState,
) {
  const events = f.ordinary.store;
  const intent = f.work.latestDelegationForHost('slice')!;
  const prepared = events.getOrdinarySessionPreparation(intent.allocationOperationId)!;
  const session = events.getSession(workerId)!;
  const metadata = {
    sessionId: session.sessionId,
    repositoryWorkspaceId: session.repositoryWorkspaceId,
    cwd: session.cwd,
    accountBinding: session.accountBinding!,
    agentProfile: session.agentProfile,
    agentContext: session.agentContext,
    mode: session.mode,
    selectedModel: session.selectedModel,
    reasoningEffort: session.reasoningEffort,
  };
  const initial = randomUUID();
  events.admitPreparedOrdinaryCommand(
    intent.allocationOperationId,
    metadata,
    prepared.settings.binding,
    {
      clientMsgId: initial,
      requestFingerprint: 'offline-first',
      selection: prepared.settings.selection,
      payload: { text: 'Explicit first command', systemPrompt: 'Offline retained guidance' },
    },
  );
  if (state === 'first_reserved') return { initial, later: null };
  events.claimOrdinaryLocalCommandDispatch(initial);
  if (state === 'first_uncertain') return { initial, later: null };
  if (state === 'first_error') {
    events.failSendCommand(initial, 'Offline worker startup failed');
    return { initial, later: null };
  }
  events.completeOrdinaryLocalCommand(initial);
  const later = randomUUID();
  const selection = {
    ...prepared.settings.selection,
    model: 'offline-later-model',
    thinking: 'high',
  };
  events.admitOrdinaryLocalContinuation(
    {
      ...metadata,
      accountBinding: {
        ...session.accountBinding!,
        model: selection.model,
      },
      selectedModel: selection.model,
      reasoningEffort: selection.thinking,
    },
    prepared.settings.binding,
    {
      clientMsgId: later,
      requestFingerprint: 'offline-later',
      selection,
      payload: { text: 'Explicit later command', systemPrompt: 'Offline retained guidance' },
    },
  );
  if (state === 'later_reserved') return { initial, later };
  events.claimOrdinaryLocalCommandDispatch(later);
  if (state === 'later_uncertain') return { initial, later };
  if (state === 'later_error') {
    events.failSendCommand(later, 'Offline later worker command failed');
    return { initial, later };
  }
  events.completeOrdinaryLocalCommand(later);
  events.upsertSession({
    sessionId: workerId,
    selectedModel: selection.model,
    reasoningEffort: selection.thinking,
  });
  if (state === 'previous_display') {
    const queued = { ...selection, model: 'offline-queued-model', thinking: 'low' };
    events.admitOrdinaryLocalContinuation(
      {
        ...metadata,
        accountBinding: { ...metadata.accountBinding, model: queued.model },
        selectedModel: queued.model,
        reasoningEffort: queued.thinking,
      },
      prepared.settings.binding,
      {
        clientMsgId: randomUUID(),
        requestFingerprint: 'offline-queued',
        selection: queued,
        payload: { text: 'Queued command', systemPrompt: 'Offline retained guidance' },
      },
    );
  }
  return { initial, later };
}

it.each([
  'first_reserved',
  'first_uncertain',
  'first_error',
  'later_reserved',
  'later_uncertain',
  'later_error',
  'previous_display',
] as const)(
  'recovers committed worker navigation independently of execution state %s',
  async (state) => {
    const f = await fixture();
    const original = await f.owner().delegate(f.actor, f.input, f.ordinary.signal);
    admitLaterSettings(f, original.workerConversationId, state);
    const metadata = f.ordinary.store.getSession(original.workerConversationId);
    const context = f.ordinary.store.getSessionEvents(original.workerConversationId);
    f.reopen();
    f.resolvePreparation.mockClear();
    const allocate = vi.spyOn(f.ordinary.workspaces, 'prepareOrdinarySession');
    const recovered = await f
      .owner()
      .delegate(f.actor, { ...f.input, requestId: randomUUID() }, f.ordinary.signal);
    expect(recovered).toEqual(original);
    expect(allocate).not.toHaveBeenCalled();
    expect(f.resolvePreparation).not.toHaveBeenCalled();
    expect(f.ordinary.store.getSession(original.workerConversationId)).toEqual(metadata);
    expect(f.ordinary.store.getSessionEvents(original.workerConversationId)).toEqual(context);
    expect(f.tasks.getTree()).toHaveLength(1);
  },
);

it('recovers a committed receipt after later ordinary inference changes without rewriting selections', async () => {
  const f = await fixture();
  const first = await f.owner().delegate(f.actor, f.input, f.ordinary.signal);
  admitLaterSettings(f, first.workerConversationId);
  const session = f.ordinary.store.getSession(first.workerConversationId)!;
  const context = resolveTelosWorkRoleContext(
    f.ordinary.store,
    first.workerConversationId,
    session.accountBinding!,
  );
  f.reopen();
  f.resolvePreparation.mockClear();
  const recovered = await f.owner().delegate(f.actor, f.input, f.ordinary.signal);
  expect(recovered).toEqual(first);
  expect(f.ordinary.store.getSession(first.workerConversationId)).toEqual(session);
  expect(
    resolveTelosWorkRoleContext(
      f.ordinary.store,
      first.workerConversationId,
      session.accountBinding!,
    ),
  ).toEqual(context);
  expect(f.resolvePreparation).not.toHaveBeenCalled();
});

it('keeps unfinished linkage strict after later admitted inference changes', async () => {
  const f = await fixture();
  const complete = vi.spyOn(f.work, 'completeDelegation').mockImplementationOnce(() => {
    throw Error('Crash before linkage');
  });
  await expect(f.owner().delegate(f.actor, f.input, f.ordinary.signal)).rejects.toThrow('Crash');
  complete.mockRestore();
  const intent = f.work.latestDelegationForHost('slice')!;
  const prepared = f.ordinary.store.getOrdinarySessionPreparation(intent.allocationOperationId)!;
  admitLaterSettings(f, prepared.sessionId);
  await expect(f.owner().delegate(f.actor, f.input, f.ordinary.signal)).rejects.toThrow();
  expect(f.work.read('slice', f.actor).links).toEqual([]);
});

it.each(['account', 'target', 'workspace', 'missing'] as const)(
  'refuses committed receipt recovery with changed %s historical identity/proof',
  async (kind) => {
    const f = await fixture();
    const first = await f.owner().delegate(f.actor, f.input, f.ordinary.signal);
    admitLaterSettings(f, first.workerConversationId);
    f.corruptWorkerProof(first.workerConversationId, kind);
    const allocate = vi.spyOn(f.ordinary.workspaces, 'prepareOrdinarySession');
    await expect(f.owner().delegate(f.actor, f.input, f.ordinary.signal)).rejects.toThrow();
    expect(allocate).not.toHaveBeenCalled();
    expect(f.tasks.getTree()).toHaveLength(1);
  },
);

it('provisions only the exact child through ordinary owners with retained context and no turn', async () => {
  const f = await fixture();
  const leadBefore = f.ordinary.store.getSession(f.lead.sessionId);
  const receipt = await f.owner().delegate(f.actor, f.input, f.ordinary.signal);
  expect(receipt).toMatchObject({ version: 1, state: 'chat_ready', execution: 'not_started' });
  expect(receipt.workerConversationId).not.toBe(f.lead.sessionId);
  expect(receipt.workerPath).toBe(`/chat/${receipt.workerConversationId}`);
  expect(receipt.itemPath).toBe('/todos/slice');
  expect(receipt.leadPath).toBe(`/chat/${f.lead.sessionId}`);
  const session = f.ordinary.store.getSession(receipt.workerConversationId)!;
  const context = resolveTelosWorkRoleContext(
    f.ordinary.store,
    receipt.workerConversationId,
    session.accountBinding!,
  );
  expect(context).toEqual(f.input.contextSelection);
  expect(session.accountBinding).toEqual(leadBefore?.accountBinding);
  expect(session.repositoryWorkspaceId).not.toBe(f.input.settings.repositoryWorkspaceId);
  expect(f.ordinary.store.getSession(f.lead.sessionId)).toEqual(leadBefore);
  expect(f.work.read('sibling', f.actor).attempts).toEqual([]);
  expect(f.work.read('slice', f.actor).assignments).toEqual([]);
  expect(f.tasks.getTree()).toHaveLength(1);
  const task = f.tasks.getTree()[0];
  expect(task).toMatchObject({
    title: 'Slice one',
    description: f.input.contextSelection.brief.text,
    status: 'pending',
    sessionId: null,
  });
  expect(f.tasks.getTelosExecutionBinding(task.id)).toMatchObject({
    childItemId: 'slice',
    leadConversationId: f.lead.sessionId,
    workerConversationId: receipt.workerConversationId,
    contextHash: createHash('sha256')
      .update(JSON.stringify(TelosWorkRoleContextSelectionSchema.parse(f.input.contextSelection)))
      .digest('hex'),
  });
  const prepared = f.ordinary.store.getOrdinarySessionPreparation(session.repositoryWorkspaceId!);
  expect(prepared).toMatchObject({ sessionId: receipt.workerConversationId, firstCommandId: null });
  expect(
    f.ordinary.store.getOrdinaryInitialCommandId(receipt.workerConversationId),
  ).toBeUndefined();
  expect(
    f.ordinary.store.getLatestOrdinaryCommandAdmission(receipt.workerConversationId),
  ).toBeUndefined();
  expect(
    f.ordinary.store.getSessionEvents(receipt.workerConversationId).map((event) => event.type),
  ).not.toContain('user_message');
});

it('refuses an ambiguous or malformed child selector before allocation', async () => {
  const f = await fixture();
  const prepare = vi.spyOn(f.ordinary.workspaces, 'prepareOrdinarySession');
  for (const childItemId of [undefined, ['slice', 'sibling'], 'outcome']) {
    await expect(
      f.owner().delegate(f.actor, { ...f.input, childItemId }, f.ordinary.signal),
    ).rejects.toThrow();
  }
  expect(prepare).not.toHaveBeenCalled();
  expect(f.work.read('slice', f.actor).attempts).toEqual([]);
});

it('deduplicates default starts with concurrent different request IDs and exact replays', async () => {
  const f = await fixture();
  const [first, concurrent] = await Promise.all([
    f.owner().delegate(f.actor, f.input, f.ordinary.signal),
    f.owner().delegate(f.actor, { ...f.input, requestId: randomUUID() }, f.ordinary.signal),
  ]);
  const replay = await f.owner().delegate(f.actor, f.input, f.ordinary.signal);
  expect(concurrent).toEqual(first);
  expect(replay).toEqual(first);
  expect(f.work.read('slice', f.actor).attempts).toHaveLength(1);
  expect(f.tasks.getTree()).toHaveLength(1);
});

it('recovers the original ordinary receipt and task after a crash before work linkage', async () => {
  const f = await fixture();
  const complete = vi.spyOn(f.work, 'completeDelegation').mockImplementationOnce(() => {
    throw new Error('Crash before work linkage');
  });
  await expect(f.owner().delegate(f.actor, f.input, f.ordinary.signal)).rejects.toThrow('Crash');
  complete.mockRestore();
  const intent = f.work.prepareDelegation(f.input, f.actor).intent;
  const allocated = f.ordinary.store.getOrdinarySessionPreparation(intent.allocationOperationId)!;
  expect(allocated).toBeDefined();
  const taskId = f.tasks.getTree()[0].id;
  f.reopen();
  f.resolvePreparation.mockClear();
  const allocate = vi.spyOn(f.ordinary.workspaces, 'prepareOrdinarySession');
  const recovered = await f.owner().delegate(f.actor, f.input, f.ordinary.signal);
  expect(recovered.workerConversationId).toBe(allocated.sessionId);
  expect(recovered.attempt.executionTaskId).toBe(taskId);
  expect(f.tasks.getTree()).toHaveLength(1);
  expect(allocate).not.toHaveBeenCalled();
  expect(f.resolvePreparation).not.toHaveBeenCalled();
});

it('recovers a lost ordinary preparation response without allocating another workspace', async () => {
  const f = await fixture();
  const original = f.ordinary.workspaces.prepareOrdinarySession.bind(f.ordinary.workspaces);
  const prepare = vi
    .spyOn(f.ordinary.workspaces, 'prepareOrdinarySession')
    .mockImplementationOnce(async (...args) => {
      await original(...args);
      throw Error('Lost response');
    });
  await expect(f.owner().delegate(f.actor, f.input, f.ordinary.signal)).rejects.toThrow('Lost');
  prepare.mockRestore();
  const intent = f.work.prepareDelegation(f.input, f.actor).intent;
  const saved = f.ordinary.store.getOrdinarySessionPreparation(intent.allocationOperationId)!;
  expect(saved).toBeDefined();
  const workspace = vi.spyOn(f.ordinary.workspaces, 'prepareDelegatedWorkspace');
  const receipt = await f.owner().delegate(f.actor, f.input, f.ordinary.signal);
  expect(receipt.workerConversationId).toBe(saved.sessionId);
  expect(workspace).not.toHaveBeenCalled();
});

it('requires the exact retained task mapping before recording a ready worker', async () => {
  const f = await fixture();
  const mapping = vi.spyOn(f.tasks, 'getTelosExecutionBinding').mockReturnValue(null);
  await expect(f.owner().delegate(f.actor, f.input, f.ordinary.signal)).rejects.toThrow(/receipt/i);
  mapping.mockRestore();
  expect(f.work.read('slice', f.actor).links).toEqual([]);
  expect(f.work.read('slice', f.actor).attempts).toMatchObject([{ state: 'allocation_uncertain' }]);
  const taskId = f.tasks.getTree()[0].id;
  const allocate = vi.spyOn(f.ordinary.workspaces, 'prepareOrdinarySession');
  const recovered = await f.owner().delegate(f.actor, f.input, f.ordinary.signal);
  expect(recovered.attempt.executionTaskId).toBe(taskId);
  expect(allocate).not.toHaveBeenCalled();
});

it('refuses authority lost during source preparation before allocation', async () => {
  const f = await fixture();
  const preparation = await f.resolvePreparation();
  f.resolvePreparation.mockImplementationOnce(async () => {
    f.revoke();
    return preparation;
  });
  const allocate = vi.spyOn(f.ordinary.workspaces, 'prepareOrdinarySession');
  await expect(f.owner().delegate(f.actor, f.input, f.ordinary.signal)).rejects.toThrow('revoked');
  expect(allocate).not.toHaveBeenCalled();
  expect(f.work.read('slice', f.actor).attempts).toMatchObject([{ state: 'allocation_uncertain' }]);
});

it('applies the initial synchronous authority denial before retaining any request', async () => {
  const f = await fixture();
  f.revoke();
  await expect(f.owner().delegate(f.actor, f.input, f.ordinary.signal)).rejects.toThrow('revoked');
  expect(f.work.read('slice', f.actor).attempts).toEqual([]);
  expect(f.resolvePreparation).not.toHaveBeenCalled();
});

it('rejects canonical brief changes across a preparation await while retaining the original intent', async () => {
  const f = await fixture();
  const preparation = await f.resolvePreparation();
  f.resolvePreparation.mockImplementationOnce(async () => {
    f.changeChildRecord();
    return preparation;
  });
  const allocate = vi.spyOn(f.ordinary.workspaces, 'prepareOrdinarySession');
  await expect(f.owner().delegate(f.actor, f.input, f.ordinary.signal)).rejects.toThrow(
    /context changed/i,
  );
  expect(allocate).not.toHaveBeenCalled();
  const attempt = f.work.read('slice', f.actor).attempts[0];
  expect(attempt.state).toBe('allocation_uncertain');
  expect(f.work.latestDelegationForHost('slice')?.input.contextSelection).toEqual(
    f.input.contextSelection,
  );
});

it('rejects lead replacement during preparation before creating a delegated worker', async () => {
  const f = await fixture();
  const preparation = await f.resolvePreparation();
  f.resolvePreparation.mockImplementationOnce(async () => {
    f.ordinary.store.upsertSession({ sessionId: 'replacement-lead' });
    f.command('outcome', {
      operation: 'link',
      role: 'lead',
      conversation: {
        namespace: 'mitzo',
        conversationId: 'replacement-lead',
      },
    });
    f.command('outcome', {
      operation: 'assign',
      role: 'lead',
      conversationId: 'replacement-lead',
      expectedAssignmentRevision: 1,
    });
    return preparation;
  });
  const allocate = vi.spyOn(f.ordinary.workspaces, 'prepareOrdinarySession');
  await expect(f.owner().delegate(f.actor, f.input, f.ordinary.signal)).rejects.toThrow(/lead/i);
  expect(allocate).not.toHaveBeenCalled();
  expect(f.work.read('slice', f.actor).links).toEqual([]);
});

it('refuses a changed worker account selection instead of reporting a ready chat', async () => {
  const f = await fixture();
  const preparation = await f.resolvePreparation();
  f.resolvePreparation.mockResolvedValueOnce(preparation).mockResolvedValueOnce({
    ...preparation,
    binding: { ...preparation.binding, model: 'changed-model' },
  });
  await expect(f.owner().delegate(f.actor, f.input, f.ordinary.signal)).rejects.toThrow();
  expect(f.work.read('slice', f.actor).attempts).toMatchObject([{ state: 'allocation_uncertain' }]);
  expect(f.work.read('slice', f.actor).links).toEqual([]);
});

it('retains an ordinary allocation after cancellation and links it only after renewed authority', async () => {
  const f = await fixture();
  const original = f.ordinary.workspaces.prepareOrdinarySession.bind(f.ordinary.workspaces);
  const prepare = vi
    .spyOn(f.ordinary.workspaces, 'prepareOrdinarySession')
    .mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      f.revoke();
      return result;
    });
  await expect(f.owner().delegate(f.actor, f.input, f.ordinary.signal)).rejects.toThrow('revoked');
  prepare.mockRestore();
  const attempt = f.work.read('slice', f.actor).attempts[0];
  expect(attempt.state).toBe('allocation_uncertain');
  expect(f.work.read('slice', f.actor).links).toEqual([]);
  expect(f.tasks.getTree()).toEqual([]);
  f.restore();
  const receipt = await f.owner().delegate(f.actor, f.input, f.ordinary.signal);
  expect(receipt.attempt.attemptId).toBe(attempt.attemptId);
});

it('does not allow caller mutation across an await to change retained settings or context', async () => {
  const f = await fixture();
  const input = structuredClone(f.input);
  const original = structuredClone(input);
  f.authorize.mockImplementationOnce(async () => {
    input.settings.selection.model = 'another-model';
    input.contextSelection.brief.text = 'Another child';
  });
  const receipt = await f.owner().delegate(f.actor, input, f.ordinary.signal);
  const worker = f.ordinary.store.getSession(receipt.workerConversationId)!;
  expect(worker.accountBinding?.model).toBe(original.settings.selection.model);
  expect(
    resolveTelosWorkRoleContext(
      f.ordinary.store,
      receipt.workerConversationId,
      worker.accountBinding!,
    ),
  ).toEqual(original.contextSelection);
});

it('refuses changed retained worker context on replay without replacing it', async () => {
  const f = await fixture();
  const first = await f.owner().delegate(f.actor, f.input, f.ordinary.signal);
  f.ordinary.store.append(first.workerConversationId, 'telos_work_role_context', {
    version: 1,
    selection: { ...f.input.contextSelection, itemId: 'sibling' },
  });
  const allocate = vi.spyOn(f.ordinary.workspaces, 'prepareOrdinarySession');
  await expect(f.owner().delegate(f.actor, f.input, f.ordinary.signal)).rejects.toThrow();
  expect(allocate).not.toHaveBeenCalled();
  expect(f.work.read('slice', f.actor).attempts).toHaveLength(1);
});

it('requires explicit predecessor retry and preserves existing assignments and earlier chats', async () => {
  const f = await fixture();
  f.ordinary.store.upsertSession({ sessionId: 'old-worker' });
  f.command('slice', {
    operation: 'link',
    role: 'worker',
    conversation: {
      namespace: 'mitzo',
      conversationId: 'old-worker',
    },
  });
  f.command('slice', {
    operation: 'assign',
    role: 'worker',
    conversationId: 'old-worker',
    expectedAssignmentRevision: 0,
  });
  f.input.expectedRevision = f.work.read('slice', f.actor).revision;
  f.input.contextSelection.brief.revision = f.input.expectedRevision;
  const first = await f.owner().delegate(f.actor, f.input, f.ordinary.signal);
  const retry = {
    ...structuredClone(f.input),
    requestId: randomUUID(),
    mode: 'retry' as const,
    expectedRevision: f.work.read('slice', f.actor).revision,
    predecessorAttemptId: first.attempt.attemptId,
  };
  retry.contextSelection.brief.revision = retry.expectedRevision;
  await expect(
    f.owner().delegate(f.actor, { ...retry, predecessorAttemptId: null }, f.ordinary.signal),
  ).rejects.toThrow();
  const second = await f.owner().delegate(f.actor, retry, f.ordinary.signal);
  expect(second.workerConversationId).not.toBe(first.workerConversationId);
  const view = f.work.read('slice', f.actor);
  expect(view.assignments).toMatchObject([{ conversation: { conversationId: 'old-worker' } }]);
  expect(view.attempts).toHaveLength(2);
  expect(view.attempts[1].predecessorAttemptId).toBe(first.attempt.attemptId);
  expect(view.links.map((link) => link.conversation.conversationId)).toEqual(
    expect.arrayContaining(['old-worker', first.workerConversationId, second.workerConversationId]),
  );
});

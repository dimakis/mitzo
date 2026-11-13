import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { TaskOrchestrator } from '../task-orchestrator.js';
import { resolveTelosWorkTaskToolContext } from '../telos-work-execution-authority.js';
import { handleTaskComplete } from '../task-tools.js';
import { createTelosWorkRouter } from '../telos-work-routes.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { resolveTelosWorkRolePresentation } from '../telos-work-role-presentation.js';
import { resolveTelosWorkRoleContext } from '../telos-work-role-context.js';
import { createTelosWorkDelegationHost } from '../telos-work-delegation-host.js';
import { createTelosWorkerStarter } from '../telos-worker-start.js';
import { createTelosWorkRoleHost } from '../telos-work-role-host.js';
import { TelosWorkStore } from '../telos-work-store.js';
import { TaskStore } from '../task-store.js';
import { isAvailableTelosWorkConversation } from '../telos-work-conversation.js';
import { captureTelosWorkerFirstCommandAuthority } from '../telos-worker-start-authority.js';
import { createJoiningFixture, cleanupJoiningFixtures } from './fixtures/collaboration-joining.js';

vi.mock('../chat.js', () => ({ sendToChat: vi.fn() }));

const cleanups: (() => void)[] = [];
afterEach(async () => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((f) => f());
  await cleanupJoiningFixtures();
});
async function fixture() {
  const ordinary = await createJoiningFixture();
  const root = mkdtempSync(join(tmpdir(), 's5-host-'));
  const path = join(root, 'telos.db');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = new Database(path);
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT,summary TEXT,intent TEXT,rationale TEXT,acceptance_criteria TEXT,context_hints TEXT,status TEXT,profile TEXT,updated_at TEXT);
 INSERT INTO items VALUES('outcome',NULL,'Outcome','Overall intent','','["Outcome evidence"]','{}','active','manual','original'),('slice','outcome','Slice one','Exact intent','Reason','["Slice evidence"]','{}','active','manual','original'),('sibling','outcome','Slice two','Sibling private','','[]','{}','active','manual','original');
 CREATE TABLE sources(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,raw_snippet TEXT,timestamp TEXT);
 CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT);`);
  db.close();
  const ordinaryConversation = (id: string) =>
    isAvailableTelosWorkConversation(ordinary.store.getSession(id));
  const work = new TelosWorkStore(path, { ordinaryConversation });
  const tasks = new TaskStore(join(root, 'tasks.db'));
  cleanups.push(() => {
    work.close();
    tasks.close();
  });
  const actor = { kind: 'operator' as const, id: 'operator' };
  for (const [itemId, kind] of [
    ['outcome', 'outcome'],
    ['slice', 'work_item'],
    ['sibling', 'work_item'],
  ] as const)
    work.execute(
      {
        operation: 'classify',
        itemId,
        kind,
        requestId: randomUUID(),
        expectedRevision: work.read(itemId, actor).revision,
      },
      actor,
    );
  const deps = {
    dbPath: () => path,
    events: ordinary.store,
    ordinaryConversation,
    workspaces: () => ordinary.workspaces,
    resolvePreparation: ordinary.resolvePreparation,
    authorizeSettings: vi.fn(async () => {}),
  };
  const roleHost = createTelosWorkRoleHost(deps);
  const operatorRequest = (raw: unknown) => ({
    actor,
    raw,
    signal: ordinary.signal,
    assertAuthorized: () => {},
  });
  const contextSelection = await roleHost.context(
    operatorRequest({ itemId: 'outcome', role: 'lead', sourceSnapshotIds: [], artifactRefs: [] }),
  );
  const lead = await roleHost.setup(
    operatorRequest({
      itemId: 'outcome',
      role: 'lead',
      requestId: randomUUID(),
      expectedRevision: contextSelection.brief.revision,
      expectedAssignmentRevision: 0,
      settings: ordinary.input.settings,
      contextSelection,
    }),
  );
  const leadId = lead.work.assignments.find((a) => a.role === 'lead')!.conversation.conversationId;
  let authorized = true;
  const assertAuthorized = () => {
    if (!authorized) throw new Error('Host authority revoked');
  };
  const getClientId = vi.fn(() => {
    throw new Error('No worker allocation may choose an attached client');
  });
  const orchestrator = new TaskOrchestrator({
    store: tasks,
    getClientId,
    setTaskContext: vi.fn(),
    clearTaskContext: vi.fn(),
    broadcastStatus: vi.fn(),
    broadcastTasks: vi.fn(),
  });
  const host = () =>
    createTelosWorkDelegationHost({
      ...deps,
      tasks,
      dispatch: (owner, actor, input, signal) =>
        orchestrator.delegateSlice(owner, actor, input, signal),
    });
  const input = {
    requestId: 'start-one',
    childItemId: 'slice',
    mode: 'start' as const,
    predecessorAttemptId: null,
  };
  const request = (raw: unknown = input) => ({
    actor: { kind: 'conversation' as const, id: leadId },
    raw,
    signal: ordinary.signal,
    assertAuthorized,
  });
  return {
    ordinary,
    path,
    work,
    tasks,
    host,
    input,
    request,
    leadId,
    actor,
    getClientId,
    revoke: () => {
      authorized = false;
    },
    deps,
  };
}
it('reaches the ordinary worker owner from an exact bound lead without sibling context or a turn', async () => {
  const f = await fixture();
  const receipt = await f.host().delegate(f.request());
  expect(receipt.attempt.childItemId).toBe('slice');
  expect(receipt.workerDisplay).toMatchObject({
    title: 'Slice one',
    profile: 'Agent',
    account: 'Offline',
    model: 'offline-fixture',
    target: 'This Mac',
  });
  expect(receipt.execution).toBe('not_started');
  expect(f.ordinary.store.getSession(receipt.workerConversationId)?.summary).toBe('Slice one');
  expect(receipt.workerConversationId).not.toBe(f.leadId);
  expect(f.work.read('sibling', f.actor).attempts).toHaveLength(0);
  expect(f.work.read('slice', f.actor).assignments).toEqual([]);
  expect(f.tasks.get(receipt.attempt.executionTaskId!)?.status).toBe('pending');
  expect(
    f.ordinary.store.getOrdinaryInitialCommandId(receipt.workerConversationId),
  ).toBeUndefined();
  const recovered = await f.host().delegate(f.request());
  expect(recovered).toEqual(receipt);
  const alias = await f.host().delegate(f.request({ ...f.input, requestId: 'another-start' }));
  expect(alias).toEqual(receipt);
});

it('repairs an unnamed allocated worker on recovery and preserves a chosen chat name', async () => {
  const f = await fixture();
  const receipt = await f.host().delegate(f.request());
  f.ordinary.store.upsertSession({ sessionId: receipt.workerConversationId, summary: '' });
  await f.host().delegate(f.request());
  expect(f.ordinary.store.getSession(receipt.workerConversationId)?.summary).toBe('Slice one');
  f.ordinary.store.upsertSession({ sessionId: receipt.workerConversationId, summary: 'My worker' });
  await f.host().delegate(f.request());
  expect(f.ordinary.store.getSession(receipt.workerConversationId)?.summary).toBe('My worker');
});

async function executionFixture() {
  const f = await fixture();
  const allocation = await f.host().delegate(f.request());
  let occupied = false;
  const dispatch = vi.fn(
    async (input: import('../ordinary-scoped-command.js').OwnedOrdinaryDispatchInput) => {
      input.assertCurrent?.();
      const meta = f.ordinary.store.getSession(input.sessionId)!;
      const prepared = f.ordinary.store.getOrdinarySessionPreparationForConversation(
        input.sessionId,
      )!;
      const command = input.command as { clientMsgId: string; payload: { text: string } };
      f.ordinary.store.admitPreparedOrdinaryCommand(
        prepared.allocationOperationId,
        {
          sessionId: input.sessionId,
          repositoryWorkspaceId: meta.repositoryWorkspaceId,
          cwd: meta.cwd,
          accountBinding: meta.accountBinding!,
          agentProfile: meta.agentProfile,
          agentContext: meta.agentContext,
          mode: meta.mode,
          selectedModel: meta.selectedModel,
          reasoningEffort: meta.reasoningEffort,
        },
        prepared.settings.binding,
        {
          ...command,
          requestFingerprint: 'offline-worker-start',
          selection: prepared.settings.selection,
        },
      );
      f.ordinary.store.claimOrdinaryLocalCommandDispatch(input.commandId);
      f.ordinary.store.completeOrdinaryLocalCommand(input.commandId);
    },
  );
  const qualify = vi.fn(async () => ({
    ...(await f.ordinary.resolvePreparation()),
    capabilityRevision: 'offline-capability',
  }));
  const starter = () =>
    createTelosWorkerStarter({
      events: f.ordinary.store,
      work: f.work,
      tasks: f.tasks,
      workspaces: f.ordinary.workspaces,
      qualify,
      dispatch,
      occupied: () => occupied,
      hasNativeConversation: () => false,
      accepted: () => false,
    });
  const authority = {
    sourceConversationId: f.leadId,
    operatorConnectionId: 'offline-connection',
    authSessionId: 'offline-operator',
    signal: f.ordinary.signal,
    assertCurrent: () => f.request().assertAuthorized(),
  };
  return {
    ...f,
    allocation,
    starter,
    dispatch,
    qualify,
    authority,
    occupy: () => {
      occupied = true;
    },
  };
}

it('starts the exact cold worker through ordinary admission and recovers its original command after restart', async () => {
  const f = await executionFixture();
  const before = f.ordinary.store.listSessions().length;
  const result = await f.starter()(f.allocation, f.authority);
  expect(result).toMatchObject({ allocation: f.allocation, execution: { state: 'admitted' } });
  const call = f.dispatch.mock.calls[0][0];
  expect(call).toMatchObject({
    sessionId: f.allocation.workerConversationId,
    workspaceKind: 'repository',
    preparationOperationId: f.allocation.attempt.allocationReceiptId,
    ownerAuthSessionId: 'offline-operator',
    continuation: false,
    existingOwner: false,
  });
  expect(f.ordinary.store.getOrdinaryInitialCommandId(call.sessionId)).toBe(
    result.execution.commandId,
  );
  f.ordinary.reopen();
  expect(await f.starter()(f.allocation, f.authority)).toEqual(result);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect(f.ordinary.store.listSessions()).toHaveLength(before);
  expect(f.work.read('sibling', f.actor).attempts).toHaveLength(0);
});

it('deduplicates concurrent worker starts at the existing ordinary command owner', async () => {
  const f = await executionFixture();
  const [first, second] = await Promise.all([
    f.starter()(f.allocation, f.authority),
    f.starter()(f.allocation, f.authority),
  ]);
  expect(first).toEqual(second);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});
it.each(['lead reassignment', 'tool revocation'] as const)(
  'rechecks %s from fresh pending first-command authority after admission completes',
  async (scenario) => {
    const f = await executionFixture();
    const result = await f.starter()(f.allocation, f.authority);
    let selected = true;
    const authority = captureTelosWorkerFirstCommandAuthority({
      commandId: result.execution.commandId,
      allocation: f.allocation,
      events: f.ordinary.store,
      databasePath: () => f.path,
      assertSourceCurrent() {
        if (!selected) throw Error('Startup tool deselected');
      },
    });
    expect(() => authority.assertCurrent()).not.toThrow();
    if (scenario === 'tool revocation') selected = false;
    else {
      f.ordinary.store.upsertSession({ sessionId: 'replacement-lead' });
      f.work.execute(
        {
          operation: 'setup_role',
          requestId: 'replace-current-lead',
          itemId: 'outcome',
          role: 'lead',
          conversationId: 'replacement-lead',
          expectedAssignmentRevision: 1,
          expectedRevision: f.work.read('outcome', f.actor).revision,
        },
        f.actor,
      );
    }
    expect(() => authority.assertCurrent()).toThrow();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  },
);

it.each(['wrong lead', 'revoked', 'busy', 'brief changed', 'cancelled'])(
  'refuses %s worker startup without a new command or replacement',
  async (scenario) => {
    const f = await executionFixture();
    const authority = { ...f.authority };
    if (scenario === 'wrong lead') authority.sourceConversationId = 'not-the-lead';
    if (scenario === 'revoked')
      f.qualify.mockImplementationOnce(async () => {
        f.revoke();
        return { ...(await f.ordinary.resolvePreparation()), capabilityRevision: 'offline' };
      });
    if (scenario === 'busy') f.occupy();
    if (scenario === 'brief changed') {
      const db = new Database(f.path);
      db.prepare("UPDATE items SET intent='Changed scope' WHERE id='slice'").run();
      db.close();
    }
    if (scenario === 'cancelled') authority.signal = AbortSignal.abort();
    await expect(f.starter()(f.allocation, authority)).rejects.toThrow();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(
      f.ordinary.store.getOrdinaryInitialCommandId(f.allocation.workerConversationId),
    ).toBeUndefined();
  },
);

it('retains an uncertain admission failure and never replays an already admitted worker command', async () => {
  const f = await executionFixture();
  const admit = f.dispatch.getMockImplementation()!;
  f.dispatch.mockImplementationOnce(async (input) => {
    await admit(input);
    throw Error('private transport failure');
  });
  const result = await f.starter()(f.allocation, f.authority);
  expect(result.execution).toMatchObject({ state: 'admitted' });
  expect(JSON.stringify(result)).not.toContain('private transport');
  expect(await f.starter()(f.allocation, f.authority)).toEqual(result);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});

it('retains startup uncertainty without replay when ordinary dispatch fails before an admission receipt', async () => {
  const f = await executionFixture();
  f.dispatch.mockRejectedValueOnce(Error('private startup cause'));
  const result = await f.starter()(f.allocation, f.authority);
  expect(result.execution).toMatchObject({ state: 'uncertain', code: 'worker_start_unconfirmed' });
  expect(await f.starter()(f.allocation, f.authority)).toEqual(result);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});

it('passes explicit execution through the mounted lead route and shared tool consumer', async () => {
  const f = await executionFixture();
  const app = express();
  app.use(express.json());
  app.use(
    createTelosWorkRouter({
      dbPath: () => f.path,
      operatorAuth: (_req, res) => {
        res.sendStatus(403);
      },
      verifyInternal: (req) => req.headers['x-internal-token'] === 'offline-token',
      sessionId: (id) => (id === 'exact-client' ? f.leadId : undefined),
      ordinaryConversation: (id) =>
        isAvailableTelosWorkConversation(f.ordinary.store.getSession(id)),
      delegateSlice: async (req) => {
        const allocation = await f.host().delegate(req);
        return (req.raw as { execute?: true }).execute
          ? f.starter()(allocation, f.authority)
          : allocation;
      },
    }),
  );
  const { executeTelosWorkTool } = await import('../telos-work-tools.js');
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const res = await request(app)
      .post('/api/internal/telos/work/delegate')
      .set(init.headers as Record<string, string>)
      .send(JSON.parse(init.body as string));
    return new Response(JSON.stringify(res.body), { status: res.status });
  });
  vi.stubGlobal('fetch', fetch);
  try {
    const result = await executeTelosWorkTool(
      'http://fixture',
      'exact-client',
      f.leadId,
      'offline-token',
      'TelosStartSlice',
      { ...f.input, execute: true },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      allocation: f.allocation,
      execution: { state: 'admitted' },
    });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
it('refuses ambiguous or forged scope before allocating another conversation', async () => {
  const f = await fixture();
  const before = f.ordinary.store.listSessions().length;
  await expect(
    f.host().delegate(f.request({ ...f.input, childItemId: undefined })),
  ).rejects.toThrow();
  await expect(
    f.host().delegate(f.request({ ...f.input, leadConversationId: 'other' })),
  ).rejects.toThrow();
  await expect(
    f.host().delegate({ ...f.request(), actor: { kind: 'conversation', id: 'source' } }),
  ).rejects.toThrow(/lead/i);
  expect(f.ordinary.store.listSessions()).toHaveLength(before);
});
it('revalidates canonical material after awaits and never reports false readiness', async () => {
  const f = await fixture();
  f.deps.authorizeSettings.mockImplementationOnce(async () => {
    f.revoke();
  });
  await expect(f.host().delegate(f.request())).rejects.toThrow('Host authority revoked');
  expect(f.work.read('slice', f.actor).attempts.every((a) => a.state !== 'chat_ready')).toBe(true);
});

it('mounted authenticated lead route reaches real workspace, event, task and work owners once', async () => {
  const f = await fixture();
  const app = express();
  app.use(express.json());
  app.use(
    createTelosWorkRouter({
      dbPath: () => f.path,
      operatorAuth: (_req, res) => {
        res.sendStatus(403);
      },
      verifyInternal: (req) => req.headers['x-internal-token'] === 'offline-token',
      sessionId: (id) => (id === 'exact-client' ? f.leadId : undefined),
      ordinaryConversation: (id) =>
        isAvailableTelosWorkConversation(f.ordinary.store.getSession(id)),
      delegateSlice: (req) => f.host().delegate(req),
    }),
  );
  const send = () =>
    request(app)
      .post('/api/internal/telos/work/delegate')
      .set('X-Internal-Token', 'offline-token')
      .set('X-Client-Id', 'exact-client')
      .send({ clientId: 'exact-client', sessionId: f.leadId, input: f.input });
  const first = await send();
  expect(first.status).toBe(200);
  expect(first.body.attempt.childItemId).toBe('slice');
  expect(first.body.execution).toBe('not_started');
  const replay = await send();
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual(first.body);
  expect(f.work.read('slice', f.actor).attempts).toHaveLength(1);
  expect(f.work.read('sibling', f.actor).attempts).toHaveLength(0);
  expect(f.tasks.getTree()).toHaveLength(1);
  expect(f.getClientId).not.toHaveBeenCalled();
  expect(
    f.ordinary.store.getOrdinarySessionPreparation(first.body.attempt.allocationReceiptId)
      ?.firstCommandId,
  ).toBeNull();
});

it('recovers the same worker after later lead inference changes without rebinding it', async () => {
  const f = await fixture();
  const first = await f.host().delegate(f.request());
  const events = f.ordinary.store;
  const prepared = events.getOrdinarySessionPreparationForConversation(f.leadId)!;
  const session = events.getSession(f.leadId)!;
  const meta = {
    sessionId: f.leadId,
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
    prepared.allocationOperationId,
    meta,
    prepared.settings.binding,
    {
      clientMsgId: initial,
      requestFingerprint: 'offline-lead-first',
      selection: prepared.settings.selection,
      payload: { text: 'First lead instruction', systemPrompt: 'Offline' },
    },
  );
  events.claimOrdinaryLocalCommandDispatch(initial);
  events.completeOrdinaryLocalCommand(initial);
  const later = randomUUID();
  const selection = {
    ...prepared.settings.selection,
    model: 'offline-later-model',
    thinking: 'high',
  };
  events.admitOrdinaryLocalContinuation(
    {
      ...meta,
      accountBinding: { ...meta.accountBinding, model: selection.model },
      selectedModel: selection.model,
      reasoningEffort: selection.thinking,
    },
    prepared.settings.binding,
    {
      clientMsgId: later,
      requestFingerprint: 'offline-lead-later',
      selection,
      payload: { text: 'Later lead instruction', systemPrompt: 'Offline' },
    },
  );
  events.claimOrdinaryLocalCommandDispatch(later);
  events.completeOrdinaryLocalCommand(later);
  events.upsertSession({
    sessionId: f.leadId,
    selectedModel: selection.model,
    reasoningEffort: selection.thinking,
  });
  const recovered = await f.host().delegate(f.request());
  expect(recovered).toEqual(first);
  const alias = await f
    .host()
    .delegate(f.request({ ...f.input, requestId: 'recover-after-inference' }));
  expect(alias).toEqual(first);
  expect(events.getSession(first.workerConversationId)?.selectedModel).toBe(
    prepared.settings.selection.model,
  );
  expect(f.work.read('slice', f.actor).attempts).toHaveLength(1);
});

it('rejects forged ancestor revisions before retaining a new delegation intent', async () => {
  const f = await fixture();
  const contextSelection = await createTelosWorkRoleHost(f.deps).context({
    actor: f.actor,
    raw: { itemId: 'slice', role: 'worker', sourceSnapshotIds: [], artifactRefs: [] },
    signal: f.ordinary.signal,
    assertAuthorized: () => {},
  });
  const forged = structuredClone(contextSelection);
  forged.parentCriteria[0].revision = 'forged-parent-revision';
  await expect(
    f.host().delegate({
      actor: f.actor,
      raw: {
        requestId: 'forged-parent',
        leadItemId: 'outcome',
        childItemId: 'slice',
        leadConversationId: f.leadId,
        expectedRevision: contextSelection.brief.revision,
        mode: 'start',
        predecessorAttemptId: null,
        settings: f.ordinary.input.settings,
        contextSelection: forged,
      },
      signal: f.ordinary.signal,
      assertAuthorized: () => {},
    }),
  ).rejects.toThrow(/context|revision/i);
  expect(f.work.read('slice', f.actor).attempts).toHaveLength(0);
});

it('recovers the latest explicit retry through later default-start aliases without allocating again', async () => {
  const f = await fixture();
  const first = await f.host().delegate(f.request());
  const second = await f.host().delegate(
    f.request({
      ...f.input,
      requestId: 'explicit-retry',
      mode: 'retry',
      predecessorAttemptId: first.attempt.attemptId,
    }),
  );
  expect(second.workerConversationId).not.toBe(first.workerConversationId);
  const alias = { ...f.input, requestId: 'start-after-retry' };
  const recovered = await f.host().delegate(f.request(alias));
  expect(recovered).toEqual(second);
  expect(await f.host().delegate(f.request(alias))).toEqual(second);
  expect(await f.host().delegate(f.request())).toEqual(first);
  expect(f.work.read('slice', f.actor).attempts).toHaveLength(2);
});

it('refuses a delayed task mutation when its client has rebound to another real mapped worker', async () => {
  const f = await fixture();
  const first = await f.host().delegate(f.request());
  const second = await f.host().delegate(
    f.request({
      ...f.input,
      requestId: 'second-worker',
      childItemId: 'sibling',
      mode: 'start',
      predecessorAttemptId: null,
    }),
  );
  let currentSessionId = second.workerConversationId;
  const app = express();
  app.use(express.json());
  app.post('/api/internal/task-tools/complete', (req, res) => {
    const taskId = f.tasks.getTelosExecutionTaskForConversation(currentSessionId)!;
    const selected = resolveTelosWorkTaskToolContext(
      { events: f.ordinary.store, tasks: f.tasks, work: () => f.work },
      {
        sessionId: currentSessionId,
        taskId,
        accountBinding: f.ordinary.store.getSession(currentSessionId)?.accountBinding ?? undefined,
      },
      { sessionId: req.headers['x-task-session-id'], taskId: req.headers['x-task-id'] },
    );
    if (!selected) {
      res.status(400).json({ error: 'Exact task context unavailable' });
      return;
    }
    res.json({ result: handleTaskComplete(f.tasks, selected, req.body.summary) });
  });
  const send = () =>
    request(app)
      .post('/api/internal/task-tools/complete')
      .set('X-Client-Id', 'rebound-client')
      .set('X-Task-Session-Id', first.workerConversationId)
      .set('X-Task-Id', first.attempt.executionTaskId!)
      .send({ summary: 'Original worker result' });
  const refused = await send();
  expect(refused.status).toBe(400);
  expect(f.tasks.get(first.attempt.executionTaskId!)?.status).toBe('pending');
  expect(f.tasks.get(second.attempt.executionTaskId!)?.status).toBe('pending');
  currentSessionId = first.workerConversationId;
  const accepted = await send();
  expect(accepted.status).toBe(200);
  expect(accepted.body.result).toContain('pending_review');
  expect(f.tasks.get(first.attempt.executionTaskId!)?.status).toBe('pending_review');
  expect(f.tasks.get(second.attempt.executionTaskId!)?.status).toBe('pending');
});

it('CT05: delegated workers retain admission-time names across replay and EventStore reopen without rewriting their task/context binding', async () => {
  const f = await fixture();
  const receipt = await f.host().delegate(f.request());
  const workerId = receipt.workerConversationId;
  const binding = f.ordinary.store.getSession(workerId)!.accountBinding!;
  const context = resolveTelosWorkRoleContext(f.ordinary.store, workerId, binding)!;
  const task = f.tasks.getTelosExecutionBinding(receipt.attempt.executionTaskId!)!;
  expect(context.executionTaskId).toBeUndefined();
  expect(task.contextHash).toBe(createHash('sha256').update(JSON.stringify(context)).digest('hex'));
  const display = resolveTelosWorkRolePresentation(f.ordinary.store, workerId, binding);
  expect(display).toMatchObject({
    presentation: {
      contextSha256: task.contextHash,
      item: { itemId: 'slice', title: 'Slice one' },
      overallGoal: { itemId: 'outcome', title: 'Outcome' },
      parents: [{ itemId: 'outcome', title: 'Outcome' }],
    },
  });
  const attempts = f.work.read('slice', f.actor).attempts;
  const preparations = f.ordinary.resolvePreparation.mock.calls.length;
  const db = new Database(f.path);
  try {
    db.prepare(
      "UPDATE items SET summary='A later slice title',updated_at='later' WHERE id='slice'",
    ).run();
  } finally {
    db.close();
  }
  f.ordinary.reopen();
  f.deps.events = f.ordinary.store;
  expect(await f.host().delegate(f.request())).toEqual(receipt);
  expect(resolveTelosWorkRolePresentation(f.ordinary.store, workerId, binding)).toEqual(display);
  expect(resolveTelosWorkRoleContext(f.ordinary.store, workerId, binding)).toEqual(context);
  expect(f.tasks.getTelosExecutionBinding(receipt.attempt.executionTaskId!)).toEqual(task);
  expect(f.work.read('slice', f.actor).attempts).toEqual(attempts);
  expect(f.work.read('sibling', f.actor).attempts).toEqual([]);
  expect(f.ordinary.resolvePreparation).toHaveBeenCalledTimes(preparations);
  expect(f.ordinary.store.getOrdinaryInitialCommandId(workerId)).toBeUndefined();
  expect(
    f.ordinary.store
      .getSessionEvents(workerId)
      .filter((event) => event.type === 'telos_work_role_presentation'),
  ).toHaveLength(1);
}, 60_000);

it('CT11: a real retry retires old completion authority without erasing either ordinary allocation or task attribution', async () => {
  const f = await fixture();
  const first = await f.host().delegate(f.request());
  const second = await f.host().delegate(
    f.request({
      ...f.input,
      requestId: 'explicit-retry',
      mode: 'retry',
      predecessorAttemptId: first.attempt.attemptId,
    }),
  );
  const resolve = (receipt: typeof first) =>
    resolveTelosWorkTaskToolContext(
      { events: f.ordinary.store, tasks: f.tasks, work: () => f.work },
      {
        sessionId: receipt.workerConversationId,
        taskId: receipt.attempt.executionTaskId!,
        accountBinding:
          f.ordinary.store.getSession(receipt.workerConversationId)?.accountBinding ?? undefined,
      },
      { sessionId: receipt.workerConversationId, taskId: receipt.attempt.executionTaskId },
    );
  expect(() => resolve(first)).toThrow(/superseded/i);
  expect(resolve(second)).toBe(second.attempt.executionTaskId);
  expect(
    f.work.executionTaskBinding(first.attempt.executionTaskId!, first.workerConversationId),
  ).toEqual(first.attempt);
  expect(f.tasks.get(first.attempt.executionTaskId!)?.status).toBe('pending');
  expect(f.tasks.get(second.attempt.executionTaskId!)?.status).toBe('pending');
  expect(f.ordinary.store.getSession(first.workerConversationId)).toBeDefined();
});

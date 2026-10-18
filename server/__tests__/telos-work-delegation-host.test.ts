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
import { createTelosWorkRoleHost } from '../telos-work-role-host.js';
import { TelosWorkStore } from '../telos-work-store.js';
import { TaskStore } from '../task-store.js';
import { isAvailableTelosWorkConversation } from '../telos-work-conversation.js';
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
      mode: 'retry',
      predecessorAttemptId: first.attempt.attemptId,
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

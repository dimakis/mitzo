import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TelosWorkApiClient } from '@mitzo/client';
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import { createCanonicalAdvisorFixture } from './fixtures/telos-canonical-advisor.js';
import { TelosWorkStore } from '../telos-work-store.js';
import { TelosWorkAdvisorDraft } from '../telos-work-advisor-draft.js';
import { createTelosWorkRoleHost } from '../telos-work-role-host.js';
import { createTelosWorkDelegationHost } from '../telos-work-delegation-host.js';
import { createTelosWorkRouter } from '../telos-work-routes.js';
import { createTelosArtifactRouter } from '../telos-artifact-routes.js';
import { createTelosItemRouter } from '../telos-item-routes.js';
import { TelosItemStore } from '../telos-item-store.js';
import { isAvailableTelosWorkConversation } from '../telos-work-conversation.js';
import { TaskStore } from '../task-store.js';
import { TaskOrchestrator } from '../task-orchestrator.js';
import { handleTaskComplete, handleTaskArtifact } from '../task-tools.js';
import {
  assertTelosWorkExecutionAuthority,
  resolveTelosWorkTaskToolContext,
} from '../telos-work-execution-authority.js';
import { resolveTelosWorkRoleContext } from '../telos-work-role-context.js';
import { resolveTelosWorkRolePresentation } from '../telos-work-role-presentation.js';
import { executeTelosWorkerTaskTool } from '../telos-worker-task-tools.js';
import type { OrdinaryLocalCodexOwnedDispatch } from '../ordinary-local-codex-owned-runtime.js';

vi.mock('../auth.js', async (original) => ({
  ...(await original<typeof import('../auth.js')>()),
  hasPersistentRevocationAuthority: () => true,
}));
vi.mock('../chat.js', () => ({ sendToChat: vi.fn() }));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('CT06: canonical advisor save through real ordinary dispatch retains output, pending review and explicit verified completion', async () => {
  // All account/login/native bytes and RPCs are synthetic. No model call occurs.
  const native = await ownedRuntimeFixture(cleanups, { silentPreparation: true });
  const canonical = createCanonicalAdvisorFixture('fresh', 'child');
  cleanups.push(() => canonical.close());
  // Copy the synthetic origin into the SAME real event owner used by execution.
  native.events.upsertSession(canonical.events.getSession('planning')!);
  for (const event of canonical.events.getSessionEvents('planning'))
    native.events.append('planning', event.type, event.payload);
  const available = (id: string) => isAvailableTelosWorkConversation(native.events.getSession(id));
  const work = new TelosWorkStore(canonical.dbPath, { ordinaryConversation: available });
  cleanups.push(() => work.close());
  const tasks = new TaskStore(join(native.root, 'telos-tasks.db'));
  cleanups.push(() => tasks.close());
  const material = {
    artifactId: canonical.material.id,
    revision: canonical.material.revision,
    sha256: canonical.material.sha256,
  };
  const advisor = new TelosWorkAdvisorDraft({
    work,
    events: native.events,
    artifacts: canonical.artifacts,
    assertAuthorized: () => {},
    authorizeSource: (_actor, id) => available(id),
    authorizeArtifact: (_actor, id) => canonical.artifacts.userUploadAllowed(id),
  });
  const draft = {
    ...canonical.input,
    selection: { ...canonical.input.selection, artifacts: [material] },
  };
  const preview = await advisor.preview(draft, canonical.actor);
  const saved = await advisor.save({ ...draft, previewSha256: preview.sha256 }, canonical.actor);
  const childId = saved.work.itemId;
  expect(await advisor.save({ ...draft, previewSha256: preview.sha256 }, canonical.actor)).toEqual(
    saved,
  );
  expect(
    canonical.db.prepare('SELECT first_seen,last_seen FROM items WHERE id=?').get(childId),
  ).toEqual({ first_seen: expect.any(String), last_seen: expect.any(String) });
  expect(
    canonical.db.prepare('SELECT old_status,new_status FROM history WHERE item_id=?').all(childId),
  ).toEqual([{ old_status: null, new_status: 'active' }]);
  canonical.db
    .prepare(
      `INSERT INTO items(id,parent_id,summary,intent,profile,first_seen,last_seen,created_at,updated_at)
    VALUES('sibling','studio','Sibling private','Never dispatch this sibling','manual',?,?,?,?)`,
    )
    .run(canonical.stamp, canonical.stamp, canonical.stamp, canonical.stamp);
  work.execute(
    {
      operation: 'classify',
      itemId: 'sibling',
      kind: 'work_item',
      requestId: randomUUID(),
      expectedRevision: work.read('sibling', canonical.actor).revision,
    },
    canonical.actor,
  );

  const repository = await native.prepareRepository();
  const preparedSettings = {
    ...native.events.getOrdinarySessionPreparation('allocation')!.settings,
    repositoryWorkspaceId: repository.id,
  };
  const resolvePreparation = vi.fn(async () => ({
    binding: native.reservation.binding,
    taskRoot: native.reservation.taskRoot,
    agentProfile: native.agentProfile,
  }));
  const deps = {
    dbPath: () => canonical.dbPath,
    events: native.events,
    ordinaryConversation: available,
    workspaces: () => native.workspace,
    resolvePreparation,
    authorizeSettings: vi.fn(async () => {}),
  };
  const roleHost = createTelosWorkRoleHost(deps);
  const getClientId = vi.fn(() => {
    throw Error('Legacy scheduler must not choose a worker');
  });
  const orchestrator = new TaskOrchestrator({
    store: tasks,
    getClientId,
    setTaskContext: vi.fn(),
    clearTaskContext: vi.fn(),
    broadcastStatus: vi.fn(),
    broadcastTasks: vi.fn(),
  });
  const delegateHost = createTelosWorkDelegationHost({
    ...deps,
    tasks,
    dispatch: (owner, actor, input, signal) =>
      orchestrator.delegateSlice(owner, actor, input, signal),
  });
  const clients = new Map<string, string>();
  const app = express();
  app.use(express.json());
  const verifyInternal = (req: express.Request) =>
    req.get('x-internal-token') === 'synthetic-token';
  const sessionId = (id: string) => clients.get(id);
  app.use(
    createTelosWorkRouter({
      ...deps,
      operatorAuth: (_req, res, next) => {
        res.locals.authSession = { id: canonical.actor.id, expiresAt: Date.now() + 60_000 };
        next();
      },
      verifyInternal,
      sessionId,
      roleContext: (req) => roleHost.context(req),
      roleSetup: (req) => roleHost.setup(req),
      roleReview: (req) => roleHost.review(req),
      roleSetupReviewed: (req) => roleHost.setupReviewed(req),
      delegateSlice: (req) => delegateHost.delegate(req),
    }),
  );
  app.use(
    createTelosArtifactRouter({
      dbPath: deps.dbPath,
      verifyInternal,
      sessionId,
      readFile: async () => {
        throw Error('Inline synthetic output only');
      },
    }),
  );
  app.use(createTelosItemRouter({ dbPath: deps.dbPath, verifyInternal, sessionId }));
  // Existing task guard/handlers, mounted at their real callback boundary.
  for (const operation of ['artifact', 'complete'])
    app.post('/api/internal/task-tools/' + operation, (req, res) => {
      const id = sessionId(req.get('x-client-id') ?? '');
      const taskId = id && tasks.getTelosExecutionTaskForConversation(id);
      if (!id || !taskId || !verifyInternal(req)) {
        res.sendStatus(403);
        return;
      }
      const exact = resolveTelosWorkTaskToolContext(
        { events: native.events, tasks, work: () => work },
        {
          sessionId: id,
          taskId,
          accountBinding: native.events.getSession(id)?.accountBinding ?? undefined,
        },
        { sessionId: req.get('x-task-session-id'), taskId: req.get('x-task-id') },
      );
      if (!exact) {
        res.sendStatus(409);
        return;
      }
      res.json({
        result:
          operation === 'artifact'
            ? handleTaskArtifact(tasks, exact, req.body.key, req.body.value)
            : handleTaskComplete(tasks, exact, req.body.summary),
      });
    });
  const http = async (url: string, init?: RequestInit) => {
    const call = init?.method === 'POST' ? request(app).post(url) : request(app).get(url);
    for (const [key, value] of new Headers(init?.headers)) call.set(key, value);
    if (init?.body) call.send(JSON.parse(String(init.body)));
    const response = await call;
    return new Response(JSON.stringify(response.body), { status: response.status });
  };
  const api = new TelosWorkApiClient(http);
  const leadReview = await api.reviewRoleContext({
    itemId: 'studio',
    role: 'lead',
    sourceSnapshotIds: [],
    artifactRefs: [material],
  });
  const leadReceipt = await api.setupReviewedRole({
    version: 1,
    input: {
      requestId: randomUUID(),
      itemId: 'studio',
      role: 'lead',
      expectedRevision: leadReview.selection.brief.revision,
      expectedAssignmentRevision: 0,
      settings: preparedSettings,
      contextSelection: leadReview.selection,
    },
    presentationRef: leadReview.presentationRef,
  });
  const leadId = leadReceipt.work.assignments.find((a) => a.role === 'lead')!.conversation
    .conversationId;
  clients.set('lead-client', leadId);
  const delegateInput = {
    requestId: randomUUID(),
    childItemId: childId,
    mode: 'start',
    predecessorAttemptId: null,
    sourceSnapshotIds: saved.work.sources.map((s) => s.snapshotId),
    artifactRefs: [material],
  };
  const delegate = () =>
    request(app)
      .post('/api/internal/telos/work/delegate')
      .set('x-internal-token', 'synthetic-token')
      .set('x-client-id', 'lead-client')
      .send({ clientId: 'lead-client', sessionId: leadId, input: delegateInput });
  const allocation = await delegate();
  expect(allocation.status).toBe(200);
  const receipt = allocation.body;
  expect(receipt.execution).toBe('not_started');
  expect(receipt.attempt.state).toBe('chat_ready');
  const workerId = receipt.workerConversationId;
  clients.set('worker-client', workerId);
  const taskId = receipt.attempt.executionTaskId;
  const preparation = native.events.getOrdinarySessionPreparationForConversation(workerId)!;
  const workerSession = native.events.getSession(workerId)!;
  const leadSession = native.events.getSession(leadId)!;
  expect(workerId).not.toBe(leadId);
  expect(workerSession.cwd).not.toBe(leadSession.cwd);
  expect(native.workspace.get(preparation.workspaceId).baseOid).toBe(repository.baseOid);
  const selected = resolveTelosWorkRoleContext(
    native.events,
    workerId,
    workerSession.accountBinding!,
  )!;
  expect(selected.itemId).toBe(childId);
  expect(selected.artifacts).toContainEqual(material);
  expect(selected.executionTaskId).toBeUndefined();
  expect(JSON.stringify(selected)).not.toContain('Sibling private');
  const mapping = tasks.getTelosExecutionBinding(taskId)!;
  expect(mapping.contextHash).toBe(
    createHash('sha256').update(JSON.stringify(selected)).digest('hex'),
  );
  expect(
    resolveTelosWorkRolePresentation(native.events, workerId, workerSession.accountBinding!)
      ?.presentation.item.title,
  ).toBe('Reviewed plan');
  expect(tasks.get(taskId)?.status).toBe('pending');
  expect(native.events.getOrdinaryInitialCommandId(workerId)).toBeUndefined();
  expect(preparation.firstCommandId).toBeNull();
  expect(getClientId).not.toHaveBeenCalled();
  expect(native.launch).not.toHaveBeenCalled();
  expect(native.dispatch).not.toHaveBeenCalled();
  expect(work.read('sibling', canonical.actor).attempts).toEqual([]);
  expect((await delegate()).body).toEqual(receipt);
  expect(tasks.getTree()).toHaveLength(1);

  // Explicit command enters the REAL ordinary runtime/admission/dispatch owners.
  const reservation = {
    id: preparation.workspaceId,
    binding: workerSession.accountBinding!,
    conversationId: workerId,
    taskRoot: native.reservation.taskRoot,
    runtimeBinding: preparation.settings.binding,
    commandFingerprint: preparation.preparationFingerprint,
  };
  const command = {
    ...structuredClone(native.request),
    clientMsgId: randomUUID(),
    payload: {
      text: 'Perform only the reviewed child and retain a report.',
      intent: 'Explicit worker command',
    },
  };
  const worker = native.commandFor(reservation, command);
  assertTelosWorkExecutionAuthority(
    { events: native.events, tasks, work: () => work },
    workerId,
    reservation.binding,
    taskId,
  );
  expect(worker.launch).not.toHaveBeenCalled();
  expect(
    await worker.create().admitPreparedFirst(preparation.allocationOperationId, command),
  ).toEqual({ dispatched: true });
  expect(worker.dispatch).toHaveBeenCalledOnce();
  expect(worker.launch).toHaveBeenCalledOnce();
  expect(worker.dispatch.mock.calls[0][0].payload.systemPrompt).toContain('Reviewed plan');
  expect(worker.dispatch.mock.calls[0][0].sessionId).toBe(workerId);
  expect(worker.dispatch.mock.calls[0][0].workspace.directory).toBe(workerSession.cwd);
  expect(native.events.getOrdinaryInitialCommandId(workerId)).toBe(command.clientMsgId);
  expect(
    native.events.getOrdinarySessionPreparation(preparation.allocationOperationId)?.firstCommandId,
  ).toBe(command.clientMsgId);
  expect(
    execFileSync('git', ['-C', workerSession.cwd!, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
  ).toBe(repository.baseOid);
  expect(tasks.get(taskId)?.status).toBe('pending');
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) =>
    http(new URL(String(url)).pathname, init),
  );
  const fakeProvider = vi.fn(async (turn: OrdinaryLocalCodexOwnedDispatch) => {
    await turn.lease.assertCurrent();
    expect(turn.sessionId).toBe(workerId);
    expect(turn.commandId).toBe(command.clientMsgId);
    const output = await http('/api/internal/telos/artifacts/save', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': 'synthetic-token',
        'x-client-id': 'worker-client',
      },
      body: JSON.stringify({
        requestId: 'worker-output',
        itemId: childId,
        filename: 'recording-report.md',
        title: 'Reviewed recording report',
        content: 'Recorded the first session and retained its notes.',
      }),
    });
    expect(output.status).toBe(200);
    const artifact = (await output.json()).artifact;
    expect(canonical.artifacts.read(artifact.id, artifact.revision).bytes.toString()).toBe(
      'Recorded the first session and retained its notes.',
    );
    const tools = (name: string, input: unknown) =>
      executeTelosWorkerTaskTool(
        'http://offline.test',
        'worker-client',
        workerId,
        taskId,
        'synthetic-token',
        name,
        input,
      );
    expect(
      (
        await tools('mcp__task-board__TaskArtifact', {
          key: 'report',
          value: `artifact:${artifact.id}@${artifact.revision}`,
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await tools('mcp__task-board__TaskComplete', {
          summary: 'Saved report; awaiting explicit verification.',
        })
      ).content,
    ).toContain('pending_review');
    return artifact;
  });
  const output = await fakeProvider(worker.dispatch.mock.calls[0][0]);
  expect(fakeProvider).toHaveBeenCalledOnce();
  vi.stubGlobal('fetch', originalFetch);
  expect(tasks.get(taskId)?.status).toBe('pending_review');
  expect(tasks.get(taskId)?.artifacts?.report).toBe(`artifact:${output.id}@${output.revision}`);
  expect(work.readRecord(childId, canonical.actor).status).toBe('active');
  const items = new TelosItemStore(canonical.dbPath);
  cleanups.push(() => items.close());
  // A person explicitly verifies retained output, then approves the existing task.
  expect(canonical.artifacts.read(output.id, output.revision).sha256).toBe(output.sha256);
  expect(orchestrator.approveTask(taskId)).toBe(true);
  expect(tasks.get(taskId)?.status).toBe('done');
  expect(items.read(childId).status).toBe('active');
  const verified = await request(app)
    .post('/api/internal/telos/items/update')
    .set('x-internal-token', 'synthetic-token')
    .set('x-client-id', 'lead-client')
    .send({
      itemId: childId,
      requestId: 'explicit-verified-completion',
      expectedRevision: items.read(childId).revision,
      status: 'completed',
      note: `Verified recording notes in artifact:${output.id}@${output.revision}; approved task ${taskId}.`,
    });
  expect(verified.status).toBe(200);
  expect(items.read(childId).status).toBe('completed');
  expect(items.read('studio').status).toBe('active');
  expect(items.read('sibling').status).toBe('active');
  expect(work.read('sibling', canonical.actor).attempts).toEqual([]);
  expect(getClientId).not.toHaveBeenCalled();
  expect(resolveTelosWorkRoleContext(native.events, workerId, reservation.binding)).toEqual(
    selected,
  );
}, 60_000);

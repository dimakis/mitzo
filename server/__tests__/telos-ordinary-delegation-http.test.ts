import { loadAccountProfiles } from '../account-profiles.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { TelosWorkApiClient, TelosWorkApiError } from '@mitzo/client';
import { createTelosOrdinaryWorkFixture } from './fixtures/telos-ordinary-work.js';
import { eventStore as startupStore } from '../chat.js';
import { setAuthRevocationStore, operatorAuthMiddleware, isAuthSessionCurrent } from '../auth.js';
import { createTelosWorkDelegationHost } from '../telos-work-delegation-host.js';
import { createTelosWorkRouter } from '../telos-work-routes.js';
import { TaskStore } from '../task-store.js';
import { TaskOrchestrator } from '../task-orchestrator.js';
import { reviewTelosWorkRoleContext } from '../telos-work-role-review.js';
import type { TelosWorkRoleRequest } from '../telos-work-routes.js';
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
    leadConversationId: leadId,
    expectedRevision: contextSelection.brief.revision,
    mode: 'start' as const,
    predecessorAttemptId: null,
    settings: f.input.settings,
    contextSelection,
  };
  const tasks = new TaskStore(join(f.native.root, 'tasks.db'));
  cleanup.push(() => tasks.close());
  const getClientId = vi.fn(() => {
    throw Error('No automatic execution client');
  });
  const orchestrator = new TaskOrchestrator({
    store: tasks,
    getClientId,
    setTaskContext: vi.fn(),
    clearTaskContext: vi.fn(),
    broadcastStatus: vi.fn(),
    broadcastTasks: vi.fn(),
  });
  let unsupported = false;
  const resolve = async (settings = input.settings) => {
    if (!isAuthSessionCurrent(f.native.auth)) throw Error('Revoked operator');
    return {
      binding: loadAccountProfiles().resolve(
        settings.binding.account.accountId,
        settings.selection.model,
      ),
      agentProfile: f.native.first.reserved.agentProfile,
      taskRoot: f.native.taskRoot,
      requiredCapabilities: unsupported
        ? ['git_revision']
        : ['ordinary_conversation', 'task_execution'],
    };
  };
  const ordinaryConversation = (id: string) =>
    !!f.native.events.getSession(id) && !f.native.events.getSession(id)?.isHidden;
  const host = () =>
    createTelosWorkDelegationHost({
      dbPath: () => f.canonical.dbPath,
      events: f.native.events,
      tasks,
      workspaces: () => f.native.workspaces,
      ordinaryConversation,
      resolvePreparation: async () => {
        throw Error('Repository preparation forbidden');
      },
      authorizeSettings: async () => {
        throw Error('Repository authorization forbidden');
      },
      dispatch: async () => {
        throw Error('Repository dispatcher forbidden');
      },
      ordinary: {
        resolvePreparation: (scope) => resolve(scope.settings),
        qualifySettings: (scope) => resolve(scope.input.settings),
        authorizeSettings: async (scope) => {
          await resolve(scope.settings);
        },
        dispatch: (owner, actor, input, signal) =>
          orchestrator.delegateSlice(owner, actor, input, signal),
      },
    });
  const options = {
    dbPath: () => f.canonical.dbPath,
    operatorAuth: operatorAuthMiddleware,
    verifyInternal: (req: express.Request) =>
      req.headers['x-internal-token'] === 'offline-delegation-tool',
    sessionId: (clientId: string) => (clientId === 'bound-lead-client' ? leadId : undefined),
    ordinaryConversation,
    delegateSlice: (req: TelosWorkRoleRequest) => host().delegate(req),
    ordinaryDelegateSlice: (req: TelosWorkRoleRequest) => host().delegateOrdinary(req),
  };
  const app = express();
  app.use(express.json());
  app.use(createTelosWorkRouter(options));
  const api = new TelosWorkApiClient(async (url, init) => {
    const response = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + f.native.token)
      .send(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const tool = (
    raw: object = {
      requestId: randomUUID(),
      childItemId: 'slice',
      mode: 'start',
      predecessorAttemptId: null,
    },
  ) =>
    request(app)
      .post('/api/internal/telos/work/delegate')
      .set('X-Internal-Token', 'offline-delegation-tool')
      .set('X-Client-Id', 'bound-lead-client')
      .send({ clientId: 'bound-lead-client', sessionId: leadId, input: raw });
  return {
    f,
    leadId,
    tasks,
    api,
    tool,
    input,
    getClientId,
    app,
    unsupported: () => {
      unsupported = true;
    },
  };
}
it('typed operator HTTP delegates an exact canonical child via the existing dispatcher into independent non-Git custody and recovers the same identities', async () => {
  const x = await fixture(),
    before = x.f.native.events.listSessions().length;
  const receipt = await x.api.delegateOrdinarySlice(x.input);
  expect(receipt).toMatchObject({
    state: 'chat_ready',
    execution: 'not_started',
    attempt: { childItemId: 'slice' },
  });
  expect(receipt.workerConversationId).not.toBe(x.leadId);
  const meta = x.f.native.events.getSession(receipt.workerConversationId)!;
  expect(meta.ordinaryWorkspaceId).toBeTruthy();
  expect(meta.repositoryWorkspaceId).toBeUndefined();
  expect(
    x.tasks.getTelosExecutionBinding(receipt.attempt.executionTaskId!)?.workerConversationId,
  ).toBe(receipt.workerConversationId);
  x.f.native.reopenStorage();
  x.f.restart();
  expect(await x.api.delegateOrdinarySlice(x.input)).toEqual(receipt);
  expect(x.f.native.events.listSessions()).toHaveLength(before + 1);
  expect(x.f.work.read('sibling', x.f.actor).attempts).toEqual([]);
  expect(x.f.native.first.launch).not.toHaveBeenCalled();
  expect(x.getClientId).not.toHaveBeenCalled();
});
it('the unchanged authenticated lead tool selector derives V2 settings only from its real durable ordinary lead', async () => {
  const x = await fixture();
  const raw = {
    requestId: randomUUID(),
    childItemId: 'slice',
    mode: 'start',
    predecessorAttemptId: null,
  };
  const response = await x.tool(raw);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ state: 'chat_ready', execution: 'not_started' });
  expect((await x.tool(raw)).body).toEqual(response.body);
  const attempt = x.f.work.ordinaryDelegationRequestForHost(raw.requestId, {
    kind: 'conversation',
    id: x.leadId,
  });
  expect(attempt?.input.version).toBe(2);
  expect(attempt?.input.settings).toEqual(x.f.input.settings);
  expect(
    x.f.work.delegationRequestForHost(raw.requestId, { kind: 'conversation', id: x.leadId }),
  ).toBeNull();
  expect(x.f.native.first.launch).not.toHaveBeenCalled();
  expect(x.f.native.forbidden).not.toHaveBeenCalled();
});
it('refuses unsupported trusted requirements before attempt, workspace, session or task allocation', async () => {
  const x = await fixture(),
    before = x.f.native.events.listSessions().length;
  x.unsupported();
  await expect(x.api.delegateOrdinarySlice(x.input)).rejects.toBeInstanceOf(TelosWorkApiError);
  expect(x.f.work.read('slice', x.f.actor).attempts).toEqual([]);
  expect(x.tasks.getTree()).toEqual([]);
  expect(x.f.native.events.listSessions()).toHaveLength(before);
});
it('rejects caller-supplied kind/grants and cross-origin ordinary operator requests through actual route validation', async () => {
  const x = await fixture();
  const send = (body: object) =>
    request(x.app)
      .post('/api/telos/work/delegation/ordinary/start')
      .set('Authorization', 'Bearer ' + x.f.native.token)
      .send(body);
  expect((await send({ ...x.input, workspaceKind: 'repository' })).status).toBe(400);
  expect((await send(x.input).set('Origin', 'https://untrusted.example.test')).status).toBe(403);
  expect(x.f.work.read('slice', x.f.actor).attempts).toEqual([]);
});

it('recovers the original worker after the real preparation commits but the HTTP request loses its response', async () => {
  const x = await fixture(),
    before = x.f.native.events.listSessions().length;
  const prepare = x.f.native.events.prepareOrdinaryWorkspaceSession.bind(x.f.native.events);
  let original: string | undefined;
  vi.spyOn(x.f.native.events, 'prepareOrdinaryWorkspaceSession').mockImplementationOnce(
    (...args) => {
      const receipt = prepare(...args);
      original = receipt.sessionId;
      throw Error('Injected lost committed preparation response');
    },
  );
  await expect(x.api.delegateOrdinarySlice(x.input)).rejects.toMatchObject({ status: 503 });
  expect(original).toBeTruthy();
  expect(x.f.native.events.listSessions()).toHaveLength(before + 1);
  const receipt = await x.api.delegateOrdinarySlice(x.input);
  expect(receipt.workerConversationId).toBe(original);
  expect(x.f.native.events.listSessions()).toHaveLength(before + 1);
  expect(x.f.work.read('slice', x.f.actor).attempts).toHaveLength(1);
  expect(x.f.native.first.launch).not.toHaveBeenCalled();
});
it('keeps repository V1 endpoints and the lead selector strict against caller-chosen ordinary settings', async () => {
  const x = await fixture(),
    before = x.f.native.events.listSessions().length;
  const legacy = await request(x.app)
    .post('/api/telos/work/delegation/start')
    .set('Authorization', 'Bearer ' + x.f.native.token)
    .send(x.input);
  expect(legacy.status).toBe(400);
  const tool = await x.tool({
    requestId: randomUUID(),
    childItemId: 'slice',
    mode: 'start',
    predecessorAttemptId: null,
    settings: x.input.settings,
  });
  expect(tool.status).toBe(400);
  expect(x.f.work.read('slice', x.f.actor).attempts).toEqual([]);
  expect(x.f.native.events.listSessions()).toHaveLength(before);
});

it('typed HTTP default-start aliases recover original settings even when a new request selects another valid account and model', async () => {
  const x = await fixture();
  const original = await x.api.delegateOrdinarySlice(x.input);
  const path = process.env.MITZO_ACCOUNT_PROFILES_FILE!,
    configured = JSON.parse(readFileSync(path, 'utf8'));
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
  writeFileSync(path, JSON.stringify(configured));
  const binding = loadAccountProfiles().resolve('ordinary-alternate', 'fixture-alternate-model');
  const prepared = await x.f.native.workspaces.prepareOrdinaryWorkspace({
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
        targetId: x.input.settings.binding.execution.targetId,
      },
    },
    signal: x.f.native.signal.signal,
  });
  const settings = {
    ...structuredClone(x.input.settings),
    binding: prepared.runtimeBinding,
    workspace: { kind: 'ordinary' as const, preparationId: prepared.preparationId },
    selection: { ...x.input.settings.selection, model: binding.model },
  };
  await x.f.native.workspaces.qualifyOrdinaryWorkspace({
    preparationId: prepared.preparationId,
    binding,
    settings,
    agentProfile: x.f.native.first.reserved.agentProfile,
    signal: x.f.native.signal.signal,
  });
  const before = x.f.native.events.listSessions().length,
    reserve = vi.spyOn(x.f.native.workspaces, 'reserveOrdinaryWorkspace');
  await expect(x.api.delegateOrdinarySlice({ ...x.input, settings })).rejects.toMatchObject({
    status: 409,
  });
  expect(
    await x.api.delegateOrdinarySlice({ ...x.input, requestId: randomUUID(), settings }),
  ).toEqual(original);
  expect(x.f.native.events.listSessions()).toHaveLength(before);
  expect(x.tasks.getTree()).toHaveLength(1);
  expect(reserve).not.toHaveBeenCalled();
  expect(x.f.native.events.getSession(original.workerConversationId)?.accountBinding).toEqual(
    x.f.native.binding,
  );
  expect(x.f.native.first.launch).not.toHaveBeenCalled();
});

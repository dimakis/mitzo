import type { TelosOrdinaryWorkRoleSetupInput } from '@mitzo/protocol';
import type { TelosWorkActor } from '../telos-work-store.js';
import { resolveTelosWorkRoleContext } from '../telos-work-role-context.js';
import { resolveTelosWorkRolePresentation } from '../telos-work-role-presentation.js';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTelosOrdinaryWorkFixture } from './fixtures/telos-ordinary-work.js';
import { eventStore as startupStore } from '../chat.js';
import { setAuthRevocationStore, operatorAuthMiddleware, isAuthSessionCurrent } from '../auth.js';
import { createTelosWorkRoleHost } from '../telos-work-role-host.js';
import { createTelosWorkRouter } from '../telos-work-routes.js';
import { loadAccountProfiles } from '../account-profiles.js';
import { TelosWorkApiClient } from '@mitzo/client';
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
  const f = await createTelosOrdinaryWorkFixture(cleanup),
    actor = { kind: 'operator' as const, id: f.native.auth.id };
  const workspaces = vi.fn(() => f.native.workspaces);
  const resolveSelection = async (scope: {
    actor: TelosWorkActor;
    input: TelosOrdinaryWorkRoleSetupInput;
  }) => {
    if (!isAuthSessionCurrent(f.native.auth) || scope.actor.id !== actor.id)
      throw Error('Private operator unavailable');
    const profiles = loadAccountProfiles(),
      binding = profiles.resolve(
        scope.input.settings.binding.account.accountId,
        scope.input.settings.selection.model,
      );
    profiles.validateModelSelection(
      binding,
      scope.input.settings.selection.model,
      scope.input.settings.selection.thinking,
    );
    const profile = f.native.library.version(
      'user',
      scope.input.settings.selection.agent.profileId,
      scope.input.settings.selection.agent.revision,
    );
    if (!profile) throw Error('Published profile unavailable');
    return {
      binding,
      agentProfile: profile,
      taskRoot: f.native.taskRoot,
      requiredCapabilities: ['ordinary_conversation', 'retained_artifacts'],
    };
  };
  const host = () =>
    createTelosWorkRoleHost({
      dbPath: () => f.canonical.dbPath,
      events: f.native.events,
      workspaces,
      ordinaryConversation: (id) =>
        !!f.native.events.getSession(id) && !f.native.events.getSession(id)?.isHidden,
      resolvePreparation: async () => {
        throw Error('Legacy repository preparation forbidden');
      },
      authorizeSettings: async () => {
        throw Error('Legacy repository settings forbidden');
      },
      ordinary: {
        resolveSelection,
        authorizeSettings: async (scope) => {
          await resolveSelection({ actor: scope.actor, input: scope.setup.input });
        },
      },
    });
  const app = express();
  app.use(express.json());
  app.use(
    createTelosWorkRouter({
      dbPath: () => f.canonical.dbPath,
      operatorAuth: operatorAuthMiddleware,
      verifyInternal: () => false,
      sessionId: () => undefined,
      ordinaryConversation: (id) =>
        !!f.native.events.getSession(id) && !f.native.events.getSession(id)?.isHidden,
      roleReview: (req) => host().review(req),
      roleContext: (req) => host().context(req),
      ordinaryRoleSetup: (req) => host().setupOrdinary(req),
      ordinaryRoleSetupReviewed: (req) => host().setupReviewedOrdinary(req),
    }),
  );
  const fetch = async (url: string, init?: RequestInit) => {
    const pending = init?.method === 'POST' ? request(app).post(url) : request(app).get(url);
    pending.set('Authorization', 'Bearer ' + f.native.token);
    if (init?.headers)
      for (const [key, value] of new Headers(init.headers)) pending.set(key, value);
    if (init?.body) pending.send(JSON.parse(String(init.body)));
    const response = await pending;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const api = new TelosWorkApiClient(fetch);
  const review = () =>
    api.reviewRoleContext({
      itemId: 'studio',
      role: 'lead',
      sourceSnapshotIds: [],
      artifactRefs: f.input.contextSelection.artifacts,
    });
  const post = (input: object) =>
    request(app)
      .post('/api/telos/work/roles/ordinary/setup-reviewed')
      .set('Authorization', 'Bearer ' + f.native.token)
      .send(input);
  return { f, actor, api, review, post, workspaces };
}
it('uses actual typed client, authenticated routes and canonical role host to create one ordinary lead with its exact display/context receipt and no turn', async () => {
  const { f, api, review } = await fixture(),
    before = f.native.events.listSessions().length;
  const reviewed = await review();
  const input = {
    ...f.input,
    expectedRevision: reviewed.selection.brief.revision,
    contextSelection: reviewed.selection,
  };
  const body = { version: 2 as const, input, presentationRef: reviewed.presentationRef };
  const receipt = await api.setupReviewedOrdinaryRole(body);
  const id = receipt.work.assignments[0].conversation.conversationId;
  expect(f.native.events.getSession(id)?.ordinaryWorkspaceId).toBeTruthy();
  expect(f.native.events.getSession(id)?.repositoryWorkspaceId).toBeUndefined();
  expect(resolveTelosWorkRoleContext(f.native.events, id, f.native.binding)).toEqual(
    input.contextSelection,
  );
  expect(resolveTelosWorkRolePresentation(f.native.events, id, f.native.binding)).toEqual({
    presentation: reviewed.presentation,
    presentationRef: reviewed.presentationRef,
  });
  expect(await api.setupReviewedOrdinaryRole(body)).toEqual(receipt);
  expect(f.native.events.listSessions()).toHaveLength(before + 1);
  expect(f.native.events.getOrdinaryInitialCommandId(id)).toBeUndefined();
  expect(f.native.first.launch).not.toHaveBeenCalled();
  expect(f.native.forbidden).not.toHaveBeenCalled();
});
it('returns exact durable pre-allocation stale-review proof through the typed V2 client and allows explicit fresh review without allocation on the rejected request', async () => {
  const { f, api, review, workspaces } = await fixture(),
    before = f.native.events.listSessions().length;
  const reviewed = await review();
  const input = {
    ...f.input,
    expectedRevision: reviewed.selection.brief.revision,
    contextSelection: reviewed.selection,
  };
  f.db.prepare("UPDATE items SET summary='New studio brief' WHERE id='studio'").run();
  await expect(
    api.setupReviewedOrdinaryRole({ version: 2, input, presentationRef: reviewed.presentationRef }),
  ).rejects.toMatchObject({
    status: 409,
    recovery: { version: 1, requestId: input.requestId, outcome: 'rejected_before_allocation' },
  });
  expect(workspaces).not.toHaveBeenCalled();
  expect(f.native.events.listSessions()).toHaveLength(before);
  expect(f.db.prepare('SELECT count(*) AS n FROM telos_work_role_setups').get()).toEqual({ n: 0 });
  const current = await review();
  const next = {
    ...input,
    requestId: randomUUID(),
    expectedRevision: current.selection.brief.revision,
    contextSelection: current.selection,
  };
  await api.setupReviewedOrdinaryRole({
    version: 2,
    input: next,
    presentationRef: current.presentationRef,
  });
  expect(f.native.events.listSessions()).toHaveLength(before + 1);
});
it('journals an unsupported V2 thinking rejection before role/allocation intent and exposes matching proof with an actionable reason', async () => {
  const { f, api, review } = await fixture(),
    before = f.native.events.listSessions().length;
  const reviewed = await review();
  const input = {
    ...f.input,
    settings: {
      ...f.input.settings,
      selection: { ...f.input.settings.selection, thinking: 'unavailable' },
    },
    contextSelection: reviewed.selection,
  };
  const reserve = vi.spyOn(f.native.workspaces, 'reserveOrdinaryWorkspace');
  await expect(
    api.setupReviewedOrdinaryRole({ version: 2, input, presentationRef: reviewed.presentationRef }),
  ).rejects.toMatchObject({
    status: 409,
    recovery: { requestId: input.requestId, outcome: 'rejected_before_allocation' },
    message: expect.stringContaining('thinking'),
  });
  expect(reserve).not.toHaveBeenCalled();
  expect(f.native.events.listSessions()).toHaveLength(before);
  expect(f.db.prepare('SELECT count(*) AS n FROM telos_work_role_setups').get()).toEqual({ n: 0 });
  expect(f.db.prepare('SELECT count(*) AS n FROM telos_work_role_setup_rejections').get()).toEqual({
    n: 1,
  });
});
it('recovers a lost V2 ordinary preparation response through actual HTTP with the same request and no false pre-allocation proof', async () => {
  const { f, api, review, post } = await fixture(),
    before = f.native.events.listSessions().length;
  const reviewed = await review();
  const body = {
    version: 2 as const,
    input: { ...f.input, contextSelection: reviewed.selection },
    presentationRef: reviewed.presentationRef,
  };
  const original = f.native.events.prepareOrdinaryWorkspaceSession.bind(f.native.events);
  vi.spyOn(f.native.events, 'prepareOrdinaryWorkspaceSession').mockImplementationOnce((...args) => {
    original(...args);
    throw Error('Lost V2 preparation response');
  });
  const failed = await post(body);
  expect(failed.status).toBe(503);
  expect(failed.body).not.toHaveProperty('recovery');
  const intent = f.work.prepareOrdinaryRoleSetup(body.input, {
    kind: 'operator',
    id: f.native.auth.id,
  }).setup;
  const prepared = f.native.events.getOrdinaryWorkspaceSessionPreparation(
    intent.allocationOperationId,
  )!;
  const reserve = vi.spyOn(f.native.workspaces, 'reserveOrdinaryWorkspace');
  f.restart();
  const receipt = await api.setupReviewedOrdinaryRole(body);
  expect(receipt.work.assignments[0].conversation.conversationId).toBe(prepared.sessionId);
  expect(reserve).not.toHaveBeenCalled();
  expect(f.native.events.listSessions()).toHaveLength(before + 1);
});

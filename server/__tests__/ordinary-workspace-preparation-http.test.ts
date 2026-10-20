import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ownedOrdinaryRuntimeFixture } from './fixtures/owned-ordinary-workspace-runtime.js';
import { eventStore as startupStore } from '../chat.js';
import { setAuthRevocationStore, revokeAuthSession } from '../auth.js';
import { createOrdinaryWorkspacePreparationRouter } from '../ordinary-workspace-router.js';
import { getOrdinaryWorkspaces, getRepositoryWorkspaces } from '../repository-workspace-runtime.js';
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
  const f = await ownedOrdinaryRuntimeFixture(cleanup);
  const app = express();
  app.use(express.json());
  app.use(createOrdinaryWorkspacePreparationRouter({ workspaces: () => f.workspaces }));
  const input = {
    version: 1,
    model: f.binding.model,
    runOn: 'local',
    runtime: {
      account: f.first.request.runtime.account,
      harness: f.first.request.runtime.harness,
      targetId: f.first.request.runtime.targetId,
    },
  };
  const post = (body: object = input) =>
    request(app)
      .post('/api/ordinary/workspaces/prepare')
      .set('Authorization', 'Bearer ' + f.token)
      .send(body);
  return { f, app, input, post };
}
it('prepares through authenticated real readiness while Git enrollment stays off and creates no extra session or native command', async () => {
  const { f, post } = await fixture(),
    before = f.events.listSessions().length;
  expect(process.env.MITZO_REPOSITORY_WORKSPACES_ENABLED).toBe('0');
  const response = await post();
  expect(response.status).toBe(201);
  expect(response.body).toMatchObject({
    version: 1,
    kind: 'ordinary',
    runtimeBinding: f.first.receipt.settings.binding,
    capabilities: [
      'ordinary_conversation',
      'writable_files',
      'retained_artifacts',
      'task_execution',
    ],
  });
  expect(response.body.preparationId).not.toBe(f.prepared.preparationId);
  expect(JSON.stringify(response.body)).not.toContain(f.root);
  expect(response.body).not.toHaveProperty('credentialDigest');
  expect(response.body).not.toHaveProperty('repositoryWorkspaceId');
  expect(f.events.listSessions()).toHaveLength(before);
  expect(f.events.getOrdinaryInitialCommandId(f.first.receipt.sessionId)).toBeUndefined();
  expect(f.first.launch).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('gives an actionable unsupported target denial before touching preparation or allocation', async () => {
  const { f, post, input } = await fixture();
  const prepare = vi.spyOn(f.workspaces, 'prepareOrdinaryWorkspace');
  const response = await post({ ...input, runOn: 'openshell' });
  expect(response.status).toBe(409);
  expect(response.body).toMatchObject({
    code: 'unsupported_workspace',
    error: expect.stringContaining('Local Mac Codex'),
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(f.first.launch).not.toHaveBeenCalled();
});
it('refuses forged account scope, unknown client grants and physical paths without a session or command effect', async () => {
  const { f, post, input } = await fixture(),
    before = f.events.listSessions().length;
  expect(
    (
      await post({
        ...input,
        runtime: {
          ...input.runtime,
          account: { ...input.runtime.account, profileRevision: 'forged' },
        },
      })
    ).status,
  ).toBe(409);
  expect((await post({ ...input, directory: '/fake-root' })).status).toBe(400);
  expect((await post({ ...input, capabilities: ['git_revision'] })).status).toBe(400);
  expect(f.events.listSessions()).toHaveLength(before);
  expect(f.first.launch).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('rejects internal/absent auth and cross-origin JSON through the actual operator and origin middleware', async () => {
  const { f, app, input, post } = await fixture();
  expect((await request(app).post('/api/ordinary/workspaces/prepare').send(input)).status).toBe(
    403,
  );
  expect((await post().set('Origin', 'https://untrusted.example.test')).status).toBe(403);
  expect(f.first.launch).not.toHaveBeenCalled();
});
it('rechecks private persistent operator revocation after actual readiness and does not return preparation authority', async () => {
  const { f, post } = await fixture(),
    before = f.events.listSessions().length;
  const prepare = f.workspaces.prepareOrdinaryWorkspace.bind(f.workspaces);
  vi.spyOn(f.workspaces, 'prepareOrdinaryWorkspace').mockImplementationOnce(async (input) => {
    const receipt = await prepare(input);
    revokeAuthSession(f.auth);
    return receipt;
  });
  const response = await post();
  expect(response.status).toBe(409);
  expect(response.body).not.toHaveProperty('preparationId');
  expect(f.events.listSessions()).toHaveLength(before);
  expect(f.first.launch).not.toHaveBeenCalled();
});
it('uses the existing global workspace owner for ordinary preparation without enabling repository enrollment', async () => {
  const { f, input } = await fixture();
  expect(() => getRepositoryWorkspaces()).toThrow('Repository-backed chats are not enabled');
  const owner = getOrdinaryWorkspaces();
  cleanup.push(() => owner.close());
  const forbidden = vi.spyOn(owner, 'preview').mockImplementation(async () => {
    throw Error('Git source forbidden');
  });
  const receipt = await owner.prepareOrdinaryWorkspace({
    binding: f.binding,
    selection: { runOn: 'local', runtime: input.runtime },
    signal: f.signal.signal,
  });
  expect(receipt.kind).toBe('ordinary');
  expect(forbidden).not.toHaveBeenCalled();
});

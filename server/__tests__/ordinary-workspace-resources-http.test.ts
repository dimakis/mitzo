import { afterAll, beforeAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { access, writeFile, readFile, rename, mkdir, symlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import type { ownedOrdinaryRuntimeFixture } from './fixtures/owned-ordinary-workspace-runtime.js';

const services = vi.hoisted(() => ({ workspace: undefined as unknown, remoteRead: vi.fn() }));
vi.mock('../session-artifact-reader.js', async (original) => ({
  ...(await original<object>()),
  createSessionArtifactReader: () => services.remoteRead,
}));
vi.mock('../repository-workspace-runtime.js', async (original) => ({
  ...(await original<object>()),
  getOrdinaryWorkspaces: () => services.workspace,
}));
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: 'offline-resource-internal',
  isValidInternalToken: (value: unknown) => value === 'offline-resource-internal',
  isValidSignalCallbackToken: () => false,
  createSignalCallbackToken: vi.fn(() => 'offline-callback'),
  revokeSignalCallbackToken: vi.fn(),
}));
vi.mock('../mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
  loadFromFile: () => ({}),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('No model execution');
  },
}));

const cleanup: Array<() => void | Promise<void>> = [];
let f: Awaited<ReturnType<typeof ownedOrdinaryRuntimeFixture>>;
let app: typeof import('../app.js');
let chat: typeof import('../chat.js');
let auth: typeof import('../auth.js');
let first: Awaited<ReturnType<typeof ownedOrdinaryRuntimeFixture>>['first'];
beforeAll(async () => {
  vi.resetModules();
  vi.stubEnv('MITZO_KNOWLEDGE_LIBRARY_CONFIG', undefined);
  vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No external network or model calls');
    }),
  );
  const { ownedOrdinaryRuntimeFixture } =
    await import('./fixtures/owned-ordinary-workspace-runtime.js');
  f = await ownedOrdinaryRuntimeFixture(cleanup, {
    chatRoute: true,
    separateConfiguredWorkspace: true,
  });
  services.workspace = f.workspaces;
  await writeFile(join(f.configuredWorkspace, 'global.txt'), 'Configured workspace material');
  app = await import('../app.js');
  chat = await import('../chat.js');
  auth = await import('../auth.js');
  expect(relative(f.configuredWorkspace, f.taskRoot).startsWith('..')).toBe(true);
});
beforeEach(async () => {
  first = await f.prepareSibling();
  await f.workspaces.claimOrdinaryWorkspace({ ...first.reservation, signal: f.signal.signal });
  await writeFile(join(first.reserved.directory, 'report.txt'), 'Original ordinary report');
  expect(chat.eventStore.getSession(first.receipt.sessionId)?.ordinaryWorkspaceId).toBe(
    first.reserved.id,
  );
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (f) auth.revokeAuthSession(f.auth);
  chat?.eventStore.close();
  app?.taskStore.close();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const get = (path: string) =>
  request(app.app)
    .get(path)
    .set('Authorization', 'Bearer ' + f.token)
    .query({ sessionId: first.receipt.sessionId });
it('serializes the actual ordinary workspace identity without a fabricated repository', async () => {
  const response = await get('/api/sessions/' + first.receipt.sessionId + '/meta');
  expect(response.status).toBe(200);
  expect(response.body.ordinaryWorkspaceId).toBe(first.reserved.id);
  expect(response.body).not.toHaveProperty('repositoryWorkspaceId');
  expect(response.body.runtimeBinding).toEqual(first.receipt.settings.binding);
});
it('lists, reads, edits and downloads only the real claimed ordinary directory outside configured repository roots', async () => {
  const reserve = vi.spyOn(f.workspaces, 'reserveOrdinaryWorkspace'),
    claim = vi.spyOn(f.workspaces, 'claimOrdinaryWorkspace');
  const roots = await get('/api/files/roots');
  expect(roots.status).toBe(200);
  expect(roots.body).toEqual([{ label: 'Conversation files', path: first.reserved.directory }]);
  const list = await get('/api/files');
  expect(list.status).toBe(200);
  expect(list.body).toMatchObject({
    dir: first.reserved.directory,
    root: first.reserved.directory,
    entries: [{ name: 'report.txt', isDir: false }],
  });
  const read = await get('/api/files/read').query({ path: 'report.txt' });
  expect(read.status).toBe(200);
  expect(read.body.content).toBe('Original ordinary report');
  const write = await request(app.app)
    .put('/api/files/write')
    .set('Authorization', 'Bearer ' + f.token)
    .send({
      path: 'report.txt',
      sessionId: first.receipt.sessionId,
      expectedContent: 'Original ordinary report',
      content: 'Revised report',
    });
  expect(write.status).toBe(200);
  expect(await readFile(join(first.reserved.directory, 'report.txt'), 'utf8')).toBe(
    'Revised report',
  );
  const download = await get('/api/files/download').query({ path: 'report.txt' });
  expect(download.status).toBe(200);
  expect(String(download.text ?? download.body)).toContain('Revised report');
  expect(reserve).not.toHaveBeenCalled();
  expect(claim).not.toHaveBeenCalled();
  expect(first.launch).not.toHaveBeenCalled();
});
it('refuses configured workspace, sibling and symlink escapes instead of falling back to global file grants', async () => {
  const sibling = await f.prepareSibling();
  await f.workspaces.claimOrdinaryWorkspace({ ...sibling.reservation, signal: f.signal.signal });
  const siblingFile = join(sibling.reserved.directory, 'sibling.txt');
  await writeFile(siblingFile, 'Sibling material');
  await symlink(siblingFile, join(first.reserved.directory, 'escape.txt'));
  for (const path of [
    join(f.configuredWorkspace, 'global.txt'),
    siblingFile,
    '../' + relative(f.taskRoot, sibling.reserved.directory) + '/sibling.txt',
    'escape.txt',
  ]) {
    expect((await get('/api/files/read').query({ path })).status).toBe(403);
  }
  expect((await get('/api/files').query({ dir: f.configuredWorkspace })).status).toBe(403);
});
it.each(['openai', 'openai-codex'] as const)(
  'routes ordinary OpenShell file preview, download and guarded save through remote custody for %s',
  async (provider) => {
    const binding = { ...f.binding, provider };
    const runtime = {
      ...first.receipt.settings.binding,
      account: { ...first.receipt.settings.binding.account, provider },
      execution: {
        location: 'openshell' as const,
        targetId: 'offline-sandbox',
        targetRevision: 'offline-sandbox-contract',
      },
    };
    const root = join(f.root, randomUUID());
    const taskRoot = join(root, 'tasks');
    await mkdir(taskRoot, { recursive: true, mode: 0o700 });
    const forbidden = vi.fn(async () => {
      throw Error('No repository authority');
    });
    const owner = new RepositoryWorkspaces(join(root, 'private'), {
      authorize: forbidden,
      inspect: forbidden,
      prepare: forbidden,
      ordinaryPreparation: {
        capture: async () => ({
          version: 1,
          originalBinding: binding,
          runtimeBinding: runtime,
          credentialDigest: 'a'.repeat(64),
          sandboxWorkdir: '/sandbox/workspaces/mgmt',
        }),
        assert: async () => {},
      },
    });
    try {
      services.workspace = owner;
      const prepared = await owner.prepareOrdinaryWorkspace({
        binding,
        selection: {
          runOn: 'openshell',
          runtime: {
            account: runtime.account,
            harness: 'codex',
            targetId: runtime.execution.targetId,
          },
        },
        signal: f.signal.signal,
      });
      const reserved = await owner.reserveOrdinaryWorkspace({
        binding,
        preparationId: prepared.preparationId,
        allocationOperationId: randomUUID(),
        agentProfile: first.reserved.agentProfile,
        taskRoot,
        signal: f.signal.signal,
        settings: {
          ...first.receipt.settings,
          binding: runtime,
          workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
        },
      });
      f.events.prepareOrdinaryWorkspaceSession(
        {
          sessionId: reserved.conversationId,
          ordinaryWorkspaceId: reserved.id,
          cwd: reserved.directory,
          accountBinding: binding,
          agentProfile: reserved.agentProfile,
          selectedModel: binding.model,
          reasoningEffort: reserved.settings.selection.thinking,
          mode: reserved.settings.selection.permission.mode,
        },
        {
          allocationOperationId: reserved.allocationOperationId,
          preparationFingerprint: reserved.preparationFingerprint,
          settings: reserved.settings,
        },
      );
      await owner.claimOrdinaryWorkspace({
        id: reserved.id,
        conversationId: reserved.conversationId,
        binding,
        taskRoot,
        signal: f.signal.signal,
      });
      const path = '/sandbox/workspaces/mgmt/global.txt';
      services.remoteRead
        .mockReset()
        .mockResolvedValue({ path, bytes: Buffer.from('Sandbox report') });
      for (const endpoint of ['read', 'download']) {
        const result = await request(app.app)
          .get('/api/files/' + endpoint)
          .set('Authorization', 'Bearer ' + f.token)
          .query({ sessionId: reserved.conversationId, path: 'global.txt' });
        expect(result.status).toBe(200);
        if (endpoint === 'read') expect(result.body.content).toBe('Sandbox report');
        else expect(result.text ?? result.body.toString()).toBe('Sandbox report');
      }
      const saved = await request(app.app)
        .put('/api/files/write')
        .set('Authorization', 'Bearer ' + f.token)
        .send({
          sessionId: reserved.conversationId,
          path: 'global.txt',
          content: 'Edited sandbox report',
          expectedContent: 'Sandbox report',
        });
      expect(saved.status).toBe(200);
      expect(services.remoteRead).toHaveBeenCalledTimes(3);
      expect(services.remoteRead).toHaveBeenLastCalledWith(
        reserved.conversationId,
        binding,
        reserved.directory,
        'global.txt',
      );
      expect(await readFile(join(f.configuredWorkspace, 'global.txt'), 'utf8')).toBe(
        'Configured workspace material',
      );
      const readBinding = chat.eventStore.getSessionRuntimeBinding.bind(chat.eventStore);
      vi.spyOn(chat.eventStore, 'getSessionRuntimeBinding').mockImplementation((id) =>
        id === reserved.conversationId
          ? { ...runtime, execution: { ...runtime.execution, location: 'local' } }
          : readBinding(id),
      );
      const rejected = await request(app.app)
        .get('/api/files/read')
        .set('Authorization', 'Bearer ' + f.token)
        .query({ sessionId: reserved.conversationId, path: 'global.txt' });
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
      expect(services.remoteRead).toHaveBeenCalledTimes(3);
      expect(forbidden).not.toHaveBeenCalled();
    } finally {
      services.workspace = f.workspaces;
      owner.close();
    }
  },
);

it('requires interactive authority for ordinary browser files even when the generic internal token is valid', async () => {
  const response = await request(app.app)
    .get('/api/files/read')
    .set('X-Internal-Token', 'offline-resource-internal')
    .query({ sessionId: first.receipt.sessionId, path: join(f.configuredWorkspace, 'global.txt') });
  expect(response.status).toBe(403);
  const missing = await request(app.app)
    .get('/api/files/roots')
    .query({ sessionId: first.receipt.sessionId });
  expect(missing.status).toBe(401);
});
it('uses the GET query scope even when an internal caller supplies a conflicting body', async () => {
  const response = await request(app.app)
    .get('/api/files/read')
    .set('X-Internal-Token', 'offline-resource-internal')
    .query({ sessionId: first.receipt.sessionId, path: 'report.txt' })
    .send({ sessionId: 'unrelated-legacy-conversation' });
  expect(response.status).toBe(403);
});
it.each([
  'claiming',
  'replaced-directory',
  'symlink-directory',
  'replaced-root',
  'hidden',
  'missing-kind',
  'missing-record',
] as const)(
  'fails closed for %s custody without exposing global roots or healing the original workspace',
  async (damage) => {
    const record = f.workspaces.getOrdinaryWorkspace(first.reserved.id);
    if (damage === 'claiming') {
      const db = new Database(join(f.root, 'workspace-owner', 'workspaces.db'));
      try {
        db.prepare('UPDATE ordinary_workspaces SET record=? WHERE id=?').run(
          JSON.stringify({ ...record, state: 'claiming' }),
          record.id,
        );
      } finally {
        db.close();
      }
    } else if (damage === 'missing-record') {
      const db = new Database(join(f.root, 'workspace-owner', 'workspaces.db'));
      try {
        db.prepare('DELETE FROM ordinary_workspaces WHERE id=?').run(record.id);
      } finally {
        db.close();
      }
    } else if (damage === 'missing-kind') {
      const db = new Database(join(f.configuredWorkspace, '.mitzo', 'events.db'));
      try {
        db.prepare('UPDATE sessions SET ordinary_workspace_id=NULL WHERE session_id=?').run(
          record.conversationId,
        );
      } finally {
        db.close();
      }
    } else if (damage === 'hidden') chat.eventStore.hideSession(record.conversationId);
    else if (damage === 'replaced-root') {
      await rename(f.taskRoot, f.taskRoot + '-retained');
      await mkdir(f.taskRoot, { mode: 0o700 });
    } else {
      await rename(record.directory, record.directory + '-retained');
      if (damage === 'symlink-directory')
        await symlink(record.directory + '-retained', record.directory);
      else await mkdir(record.directory, { mode: 0o700 });
    }
    const roots = await get('/api/files/roots');
    expect(roots.status).toBe(409);
    expect(roots.body.error).toBeTruthy();
    expect(JSON.stringify(roots.body)).not.toContain(f.configuredWorkspace);
    const read = await get('/api/files/read').query({
      path: join(f.configuredWorkspace, 'global.txt'),
    });
    expect(read.status).toBe(409);
    if (damage === 'missing-record') {
      expect(() => f.workspaces.getOrdinaryWorkspace(record.id)).toThrow();
      expect(await readFile(join(record.directory, 'report.txt'), 'utf8')).toBe(
        'Original ordinary report',
      );
    } else expect(f.workspaces.getOrdinaryWorkspace(record.id).id).toBe(record.id);
    expect(first.launch).not.toHaveBeenCalled();
  },
);
it('does not materialize a reserved ordinary workspace when its files are requested', async () => {
  const reserved = await f.prepareSibling();
  const claim = vi.spyOn(f.workspaces, 'claimOrdinaryWorkspace');
  const response = await request(app.app)
    .get('/api/files/roots')
    .set('Authorization', 'Bearer ' + f.token)
    .query({ sessionId: reserved.receipt.sessionId });
  expect(response.status).toBe(409);
  expect(response.body.error).toContain('first message');
  await expect(access(reserved.reserved.directory)).rejects.toThrow();
  expect(claim).not.toHaveBeenCalled();
});

it('refuses cross-origin ordinary edits without changing the retained file', async () => {
  const response = await request(app.app)
    .put('/api/files/write')
    .set('Authorization', 'Bearer ' + f.token)
    .set('Origin', 'https://untrusted.example.test')
    .send({
      sessionId: first.receipt.sessionId,
      path: 'report.txt',
      expectedContent: 'Original ordinary report',
      content: 'Untrusted change',
    });
  expect(response.status).toBe(403);
  expect(await readFile(join(first.reserved.directory, 'report.txt'), 'utf8')).toBe(
    'Original ordinary report',
  );
});
it('checks actual persistent operator revocation before ordinary file access', async () => {
  const token = await auth.login('test-passphrase-for-vitest');
  expect(token).toBeTruthy();
  const operator = await auth.authenticateToken(token!);
  expect(operator).toBeTruthy();
  const fetch = () =>
    request(app.app)
      .get('/api/files/roots')
      .set('Authorization', 'Bearer ' + token)
      .query({ sessionId: first.receipt.sessionId });
  expect((await fetch()).status).toBe(200);
  auth.revokeAuthSession(operator!);
  expect((await fetch()).status).toBe(401);
  expect(first.launch).not.toHaveBeenCalled();
});

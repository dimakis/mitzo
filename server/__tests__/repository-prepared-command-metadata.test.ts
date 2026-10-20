import type { Mock } from 'vitest';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { Response } from 'express';
import type { ConnectionRegistry } from '@mitzo/harness';
import type { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';

const services = vi.hoisted(() => ({ workspace: undefined as unknown }));
vi.mock('../repository-workspace-runtime.js', async (original) => ({
  ...(await original<object>()),
  getRepositoryWorkspaces: () => services.workspace,
}));
vi.mock('../mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
  loadFromFile: () => ({}),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('No model calls');
  },
}));
const cleanup: Array<() => void | Promise<void>> = [];
const transportCleanup: Array<() => void> = [];
let f: Awaited<ReturnType<typeof ownedRuntimeFixture>>;
let first: Awaited<ReturnType<typeof f.prepareSibling>>;
let application: typeof import('../app.js');
let chat: typeof import('../chat.js');
let auth: typeof import('../auth.js');
let token: string;
let server: Server;
let connections: ConnectionRegistry;
beforeAll(async () => {
  vi.resetModules();
  vi.stubEnv('MITZO_KNOWLEDGE_LIBRARY_CONFIG', undefined);
  vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No external network/model calls');
    }),
  );
  const { ownedRuntimeFixture } = await import('./fixtures/owned-local-codex-runtime.js');
  f = await ownedRuntimeFixture(cleanup, { chatRoute: true, silentPreparation: true });
  services.workspace = f.workspace;
  application = await import('../app.js');
  chat = await import('../chat.js');
  auth = await import('../auth.js');
  auth.setAuthRevocationStore(chat.eventStore);
  token = (await auth.login('test-passphrase-for-vitest'))!;
  expect(token).toBeTruthy();
  const { ConnectionRegistry } = await import('@mitzo/harness');
  connections = new ConnectionRegistry();
  chat.setConnectionRegistry(connections);
  const entry = await import('../ordinary-local-codex-entry.js');
  application.app.use(
    '/api/chat/local-codex',
    entry.createOwnedLocalCodexEntryRouter(application.chatSseRegistry, {
      connRegistry: connections,
      sessionRegistry: chat.registry,
      eventStore: chat.eventStore,
    }),
  );
  server = application.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Private offline port required');
  expect([3100, 3101, 3190]).not.toContain(address.port);
  vi.stubEnv('PORT', String(address.port));
});
beforeEach(async () => {
  first = await f.prepareSibling();
});
afterEach(async () => {
  const live = first && chat.registry.findBySessionId(first.reservation.conversationId);
  if (live) {
    chat.registry.abort(live.clientId);
    await vi.waitFor(() =>
      expect(chat.registry.findBySessionId(first.reservation.conversationId)).toBeFalsy(),
    );
  }
  for (const close of transportCleanup.splice(0).reverse()) close();
  vi.restoreAllMocks();
  // Release only this test's synthetic reservation from the fixture's admission
  // count. No destination checkout/provider was created by these metadata reads.
  if (first) {
    const db = new Database(join(f.root, 'repositories/workspaces.db'));
    try {
      const record = f.workspace.get(first.reserved.id);
      db.prepare('UPDATE repository_workspaces SET record=? WHERE id=?').run(
        JSON.stringify({ ...record, state: 'discarded' }),
        record.id,
      );
    } finally {
      db.close();
    }
  }
});
afterAll(async () => {
  const actor = await auth.authenticateToken(token);
  if (actor) auth.revokeAuthSession(actor);
  chat?.eventStore.close();
  application?.taskStore.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  'actual prepared repository first POST and consumed exact retry preserve %s retained-role context without another native effect',
  async (role) => {
    const currentToken = (await auth.login('test-passphrase-for-vitest'))!;
    const actor = (await auth.authenticateToken(currentToken))!;
    const connectionId = randomUUID();
    const { SseTransport } = await import('../sse-transport.js');
    const transportAuth = await import('../transport-auth-ownership.js');
    const { bindAgentLibraryTransport } = await import('../agent-library-transport.js');
    const detach = bindAgentLibraryTransport(connectionId, actor);
    const streams = application.chatSseRegistry;
    streams.add(
      connectionId,
      { write: vi.fn(() => true), end: vi.fn(), writableEnded: false } as unknown as Response,
      actor.id,
    );
    connections.register(connectionId, new SseTransport(connectionId, streams));
    transportAuth.claimTransportConnection(connectionId, actor.id);
    transportCleanup.push(() => {
      streams.remove(connectionId);
      transportAuth.releaseTransportConnection(connectionId, actor.id);
      detach();
      auth.revokeAuthSession(actor);
    });
    if (role) {
      const { createTelosCanonicalData } = await import('./fixtures/telos-canonical-advisor.js');
      const canonical = createTelosCanonicalData();
      cleanup.push(() => canonical.close());
      vi.stubEnv('TELOS_DB_PATH', canonical.dbPath);
      const { TelosWorkStore } = await import('../telos-work-store.js');
      const work = new TelosWorkStore(canonical.dbPath, { ordinaryConversation: () => true });
      cleanup.push(() => work.close());
      const { reviewTelosWorkRoleContext } = await import('../telos-work-role-review.js');
      const { retainTelosWorkRoleContext } = await import('../telos-work-role-context.js');
      const selection = reviewTelosWorkRoleContext({
        work,
        artifacts: canonical.artifacts,
        actor: { kind: 'operator', id: actor.id },
        itemId: 'studio',
        role: 'advisor',
        selectedSourceSnapshotIds: [],
        selectedArtifactRefs: [],
      });
      retainTelosWorkRoleContext(
        chat.eventStore,
        first.reservation.conversationId,
        first.reservation.binding,
        selection,
      );
    }
    const fallback = first.rpc.request.getMockImplementation()!;
    let turns = 0;
    (first.rpc.request as Mock<(method: string) => Promise<unknown>>).mockImplementation(
      async (method) => {
        if (method === 'thread/start')
          return {
            thread: { id: 'prepared-repo-thread' },
            model: 'fixture-model',
            modelProvider: 'openai',
          };
        if (method === 'turn/start') {
          turns++;
          return { turn: { id: 'prepared-repo-turn' } };
        }
        return fallback(method);
      },
    );
    const { CodexAppServerClient } = await import('../codex-app-server-client.js');
    const launch = vi
      .spyOn(CodexAppServerClient, 'launchIsolated')
      .mockReturnValue(first.rpc as never);
    const wire = { ...first.request, runOn: 'local', repositoryWorkspaceId: first.reserved.id };
    const send = (body: object, sendToken = currentToken, sendConnectionId = connectionId) =>
      request(server)
        .post('/api/chat/local-codex/send')
        .set('Authorization', 'Bearer ' + sendToken)
        .set('X-Connection-ID', sendConnectionId)
        .send(body);
    const initial = await send(wire);
    expect(initial.status, JSON.stringify(initial.body)).toBe(202);
    await vi.waitFor(() => expect(turns).toBe(1));
    expect(chat.eventStore.getOrdinaryCommandAdmission(wire.clientMsgId)?.state).toBe('consumed');
    const retry = await send(wire);
    expect(retry.status, JSON.stringify(retry.body)).toBe(202);
    expect(retry.body).toMatchObject({
      dispatched: false,
      state: 'consumed',
      sessionId: first.reservation.conversationId,
    });
    for (const changed of [
      { ...wire, payload: { ...wire.payload, text: 'Changed body must not replay' } },
      {
        ...wire,
        payload: { ...wire.payload, images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }] },
      },
      { ...wire, selection: { ...wire.selection, model: 'another-model' } },
      {
        ...wire,
        runtime: {
          ...wire.runtime,
          account: { ...wire.runtime.account, profileRevision: 'another-revision' },
        },
      },
      { ...wire, repositoryWorkspaceId: randomUUID() },
      { ...wire, clientMsgId: randomUUID() },
    ])
      expect((await send(changed)).status).toBe(409);
    const prepared = chat.eventStore.getOrdinarySessionPreparationForConversation(
      first.reservation.conversationId,
    )!;
    const db = new Database(join(f.root, '.mitzo/events.db'));
    try {
      for (const changed of [
        { ...prepared, preparationFingerprint: 'f'.repeat(64) },
        { ...prepared, firstCommandId: 'another-command' },
        {
          ...prepared,
          settings: {
            ...prepared.settings,
            selection: { ...prepared.settings.selection, model: 'another-model' },
          },
        },
      ]) {
        db.prepare('UPDATE ordinary_session_preparations SET receipt=? WHERE session_id=?').run(
          JSON.stringify(changed),
          prepared.sessionId,
        );
        expect((await send(wire)).status).toBe(409);
      }
    } finally {
      db.prepare('UPDATE ordinary_session_preparations SET receipt=? WHERE session_id=?').run(
        JSON.stringify(prepared),
        prepared.sessionId,
      );
      db.close();
    }
    const foreignToken = (await auth.login('test-passphrase-for-vitest'))!;
    const foreign = (await auth.authenticateToken(foreignToken))!;
    const foreignConnection = randomUUID();
    const detachForeign = bindAgentLibraryTransport(foreignConnection, foreign);
    streams.add(
      foreignConnection,
      { write: vi.fn(() => true), end: vi.fn(), writableEnded: false } as unknown as Response,
      foreign.id,
    );
    connections.register(foreignConnection, new SseTransport(foreignConnection, streams));
    transportAuth.claimTransportConnection(foreignConnection, foreign.id);
    transportCleanup.push(() => {
      streams.remove(foreignConnection);
      transportAuth.releaseTransportConnection(foreignConnection, foreign.id);
      detachForeign();
      auth.revokeAuthSession(foreign);
    });
    expect((await send(wire, foreignToken, foreignConnection)).status).toBe(403);
    expect((await send(wire)).status).toBe(202);
    auth.revokeAuthSession(actor);
    expect((await send(wire)).status).toBe(401);
    expect(turns).toBe(1);
    expect(launch).toHaveBeenCalledOnce();
    const native = await import('../codex-chat-session.js');
    expect(
      native
        .getCodexConversationStore()
        .commands(first.reservation.conversationId, first.reservation.binding),
    ).toHaveLength(1);
  },
);
const get = () =>
  request(application.app)
    .get('/api/sessions/' + first.reservation.conversationId + '/meta')
    .set('Authorization', 'Bearer ' + token);

it.each(['hidden', 'revoked'] as const)(
  'rechecks the %s original owner after awaited repository qualification',
  async (damage) => {
    const currentToken = (await auth.login('test-passphrase-for-vitest'))!;
    const actor = (await auth.authenticateToken(currentToken))!;
    const original = f.workspace.qualifyPreparedHostSession.bind(f.workspace);
    vi.spyOn(f.workspace, 'qualifyPreparedHostSession').mockImplementationOnce(async (...args) => {
      await original(...args);
      if (damage === 'hidden') f.events.hideSession(first.reservation.conversationId);
      else auth.revokeAuthSession(actor);
    });
    const response = await request(application.app)
      .get('/api/sessions/' + first.reservation.conversationId + '/meta')
      .set('Authorization', 'Bearer ' + currentToken);
    expect(response.status).toBe(200);
    expect(response.body.runtimeCommandScope).not.toBe('prepared-first-command');
    expect(response.body.runtimeCommandReason).toMatch(/preserve|original|unavailable/i);
    expect(first.launch).not.toHaveBeenCalled();
  },
);

it('projects only the original V1 silent repository preparation as first-command-ready without allocation, claim or native launch', async () => {
  const reserve = vi.spyOn(f.workspace, 'reserveHostTask');
  const claim = vi.spyOn(f.workspace, 'claimReservedHostTask');
  const before = f.events.getOrdinarySessionPreparationForConversation(
    first.reservation.conversationId,
  );
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.body.runtimeCommandScope).toBe('prepared-first-command');
  expect(response.body.repositoryWorkspaceId).toBe(first.reserved.id);
  expect(response.body.ordinaryWorkspaceId).toBeUndefined();
  expect(response.body.runtimeBinding).toEqual(before!.settings.binding);
  expect(
    f.events.getOrdinarySessionPreparationForConversation(first.reservation.conversationId),
  ).toEqual(before);
  expect(f.events.getOrdinaryInitialCommandId(first.reservation.conversationId)).toBeUndefined();
  expect(reserve).not.toHaveBeenCalled();
  expect(claim).not.toHaveBeenCalled();
  expect(first.launch).not.toHaveBeenCalled();
  await expect(access(first.reserved.directory)).rejects.toThrow();
});

it.each([
  'missing',
  'mismatched-workspace',
  'retired',
  'wrong-settings',
  'wrong-root',
  'missing-proof',
] as const)(
  'withholds prepared-first for %s repository preparation without repairing it',
  async (damage) => {
    const db = new Database(
      join(
        f.root,
        damage === 'retired' || damage === 'wrong-root' || damage === 'missing-proof'
          ? 'repositories/workspaces.db'
          : '.mitzo/events.db',
      ),
    );
    try {
      if (damage === 'retired' || damage === 'wrong-root' || damage === 'missing-proof') {
        const record = f.workspace.get(first.reserved.id);
        db.prepare('UPDATE repository_workspaces SET record=? WHERE id=?').run(
          JSON.stringify(
            damage === 'retired'
              ? { ...record, state: 'discarded' }
              : damage === 'missing-proof'
                ? { ...record, ordinaryPreparation: undefined }
                : { ...record, hostReservation: { ...record.hostReservation!, taskRoot: f.root } },
          ),
          record.id,
        );
      } else if (damage === 'missing')
        db.prepare('DELETE FROM ordinary_session_preparations WHERE session_id=?').run(
          first.reservation.conversationId,
        );
      else if (damage === 'mismatched-workspace')
        db.prepare('UPDATE sessions SET repository_workspace_id=? WHERE session_id=?').run(
          '00000000-0000-4000-8000-000000000001',
          first.reservation.conversationId,
        );
      else
        db.prepare('UPDATE sessions SET selected_model=? WHERE session_id=?').run(
          'unreviewed-model',
          first.reservation.conversationId,
        );
    } finally {
      db.close();
    }
    const response = await get();
    expect(response.body.runtimeCommandScope).not.toBe('prepared-first-command');
    expect(first.launch).not.toHaveBeenCalled();
    expect(f.events.getOrdinaryInitialCommandId(first.reservation.conversationId)).toBeUndefined();
  },
);

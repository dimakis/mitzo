import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventStore } from '../event-store.js';

const catalog = vi.hoisted(() => ({ refresh: vi.fn(async () => {}), catalog: () => [] }));
const native = vi.hoisted(() => ({ hasConversation: vi.fn(() => false) }));
const diagnostics = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../logger.js', async (original) => {
  const actual = await original<typeof import('../logger.js')>();
  return {
    ...actual,
    createLogger: (module: string) => {
      const logger = actual.createLogger(module);
      return module === 'server' ? { ...logger, warn: diagnostics.warn } : logger;
    },
  };
});
vi.mock('../account-profiles.js', async (original) => ({
  ...(await original<object>()),
  loadAccountProfiles: () => ({ ...catalog, privateCodexRoots: () => [] }),
}));
vi.mock('../codex-chat-session.js', async (original) => ({
  ...(await original<object>()),
  readCodexQueue: () => undefined,
  getCodexConversationStore: () => native,
}));
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  authMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  operatorAuthMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: '0'.repeat(64),
  isValidInternalToken: () => false,
  isValidSignalCallbackToken: () => false,
  createSignalCallbackToken: vi.fn(),
  revokeSignalCallbackToken: vi.fn(),
}));
let server: Server;
let store: EventStore;
let root: string;

it('delivers reply read state through the authenticated list and metadata routes', async () => {
  const id = 'read-state-entry';
  store.upsertSession({ sessionId: id, conversationSource: 'mitzo', summary: 'Read marker' });
  store.append(id, 'message_start', { messageId: 'reply' });
  store.append(id, 'block_delta', {
    messageId: 'reply',
    blockType: 'text',
    delta: 'Visible reply',
  });
  const seq = store.append(id, 'message_end', { messageId: 'reply' });
  const state = await request(server).get(`/api/sessions/${id}/read-state`);
  expect(state.status).toBe(200);
  expect(state.body).toMatchObject({ latestReplySeq: seq, readReplySeq: 0, revision: 0 });
  const marked = await request(server)
    .put(`/api/sessions/${id}/read-state`)
    .send({ readReplySeq: seq, expectedRevision: 0 });
  expect(marked.status).toBe(200);
  expect(marked.body).toMatchObject({ readReplySeq: seq, revision: 1 });
  const listed = await request(server).get('/api/sessions');
  expect(
    listed.body.sessions.find((session: { id: string }) => session.id === id).replyReadState,
  ).toMatchObject({ readReplySeq: seq, revision: 1 });
  store.hideSession(id);
  expect(
    (
      await request(server)
        .put(`/api/sessions/${id}/read-state`)
        .send({ markedUnread: true, expectedRevision: 1 })
    ).status,
  ).toBe(404);
});

it.each([false, true, 'unavailable'] as const)(
  'projects native presence for pre-runtime OpenAI metadata (%s) without inventing a runtime',
  async (presence) => {
    const id = `pre-runtime-${presence}`;
    store.upsertSession({
      sessionId: id,
      cwd: '/sandbox/workspaces/mgmt',
      accountBinding: {
        accountId: 'work',
        accountLabel: 'Work',
        provider: 'openai',
        model: 'offline-fixture',
        profileRevision: 'fixture',
      },
    });
    if (presence === 'unavailable')
      native.hasConversation.mockImplementationOnce(() => {
        throw Error('Native read unavailable');
      });
    else native.hasConversation.mockReturnValueOnce(presence);
    const response = await request(server).get(`/api/sessions/${id}/meta`);
    expect(response.status).toBe(200);
    if (presence === 'unavailable')
      expect(response.body).not.toHaveProperty('hasNativeCodexConversation');
    else expect(response.body.hasNativeCodexConversation).toBe(presence);
    expect(store.getSessionRuntimeBinding(id)).toBeNull();
  },
);
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-meta-visibility-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('TELOS_DB_PATH', join(root, 'todo.db'));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network calls in metadata fixture');
    }),
  );
  const loaded = await import('../app.js');
  server = await listenOnLoopback(loaded.app);
  store = (await import('../chat.js')).eventStore;
});
afterAll(async () => {
  if (server) await closeTestServer(server);
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('reports authoritative visibility while preserving hidden session metadata and missing 404', async () => {
  store.upsertSession({ sessionId: 'retained-briefing', summary: 'Report discussion' });
  const visible = await request(server).get('/api/sessions/retained-briefing/meta');
  expect(visible.status).toBe(200);
  expect(visible.body).toMatchObject({ sessionId: 'retained-briefing', isHidden: false });
  store.hideSession('retained-briefing');
  const hidden = await request(server).get('/api/sessions/retained-briefing/meta');
  expect(hidden.status).toBe(200);
  expect(hidden.body).toMatchObject({ sessionId: 'retained-briefing', isHidden: true });
  expect(store.getSession('retained-briefing')?.isHidden).toBe(true);
  expect((await request(server).get('/api/sessions/missing/meta')).status).toBe(404);
});
it('keeps all chats visible when bulk archive encounters an uncertain resource release', async () => {
  store.upsertSession({ sessionId: 'uncertain-release' });
  store.upsertSession({ sessionId: 'safe-to-archive' });
  store.removals.begin('uncertain-release', 'original-removal', 'resources');
  store.removals.markPrepared('uncertain-release', 'original-removal');
  store.removals.transition('uncertain-release', 'original-removal', 'closing', 'releasing');
  store.removals.transition(
    'uncertain-release',
    'original-removal',
    'releasing',
    'failed',
    'Unknown',
  );
  await request(server).delete('/api/sessions').expect(409);
  expect(store.getSession('uncertain-release')?.isHidden).toBeFalsy();
  expect(store.getSession('safe-to-archive')?.isHidden).toBeFalsy();
  store.removals.transition('uncertain-release', 'original-removal', 'failed', 'closing');
  store.removals.transition('uncertain-release', 'original-removal', 'closing', 'releasing');
  store.removals.transition('uncertain-release', 'original-removal', 'releasing', 'completed');
  await request(server).delete('/api/sessions').expect(200);
  expect(store.getSession('safe-to-archive')?.isHidden).toBe(true);
});
it.each([
  ['getSession', 503],
  ['getLatestOrdinaryCommandAdmission', 409],
] as const)(
  'contains a failed metadata %s read without terminating the server',
  async (method, status) => {
    const id = 'metadata-read-failure';
    store.upsertSession({ sessionId: id, cwd: root });
    const before = store.getSession(id);
    diagnostics.warn.mockClear();
    const read = vi.spyOn(store, method).mockImplementationOnce(() => {
      if (method === 'getSession')
        throw Object.assign(
          Error('Private retained admission /private/operator-store is unavailable'),
          { code: 'SQLITE_BUSY' },
        );
      throw Error('Ordinary command admission does not match durable session identity', {
        cause: Error('Private retained admission /private/operator-store is unavailable'),
      });
    });
    try {
      const failed = await request(server).get(`/api/sessions/${id}/meta`);
      expect(failed.status).toBe(status);
      expect(failed.body.error).toBeTypeOf('string');
      expect(JSON.stringify(failed.body)).not.toContain('/private/operator-store');
      expect(diagnostics.warn).toHaveBeenCalledWith('Session metadata request failed', {
        sessionId: id,
        ...(method === 'getSession'
          ? { metadataFailure: 'storage_busy', metadataErrorCode: 'SQLITE_BUSY' }
          : { metadataFailure: 'admission_identity_changed' }),
      });
      expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toContain('/private/operator-store');
    } finally {
      read.mockRestore();
    }
    const healthy = await request(server).get(`/api/sessions/${id}/meta`);
    expect(healthy.status).toBe(200);
    expect(healthy.body.cwd).toBe(root);
    expect(store.getSession(id)).toEqual(before);
  },
);
it('projects the persisted conversation creation time without changing it on metadata reads or later updates', async () => {
  const createdAt = Date.parse('2026-10-16T10:00:00Z');
  store.upsertSession({
    sessionId: 'chooser-created',
    summary: 'Original conversation',
    createdAt,
  });
  const before = store.getSession('chooser-created');
  const first = await request(server).get('/api/sessions/chooser-created/meta');
  expect(first.status).toBe(200);
  expect(first.body.createdAt).toBe(createdAt);
  expect(store.getSession('chooser-created')).toEqual(before);
  store.upsertSession({ sessionId: 'chooser-created', summary: 'Renamed later' });
  expect((await request(server).get('/api/sessions/chooser-created/meta')).body.createdAt).toBe(
    createdAt,
  );
});
it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, 8640000000000001, '2026-10-16'])(
  'omits an absent or invalid creation timestamp (%s) while preserving metadata',
  async (createdAt) => {
    store.upsertSession({ sessionId: 'chooser-invalid-created', summary: 'Retained' });
    const original = store.getSession.bind(store);
    const read = vi.spyOn(store, 'getSession').mockImplementation((id) => {
      const meta = original(id);
      return meta && id === 'chooser-invalid-created'
        ? ({ ...meta, createdAt } as typeof meta)
        : meta;
    });
    try {
      const response = await request(server).get('/api/sessions/chooser-invalid-created/meta');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ sessionId: 'chooser-invalid-created' });
      expect(response.body).not.toHaveProperty('createdAt');
    } finally {
      read.mockRestore();
    }
  },
);
it('observes deletion during optional catalog refresh before returning reuse eligibility', async () => {
  store.upsertSession({
    sessionId: 'during-refresh',
    accountBinding: {
      accountId: 'work',
      accountLabel: 'Work',
      provider: 'openai',
      model: 'luna',
      profileRevision: 'fixture',
    },
  });
  catalog.refresh.mockClear();
  catalog.refresh.mockImplementationOnce(async () => {
    store.hideSession('during-refresh');
  });
  const response = await request(server).get('/api/sessions/during-refresh/meta?refresh=1');
  expect(response.status).toBe(200);
  expect(response.body.isHidden).toBe(true);
  expect(catalog.refresh).toHaveBeenCalledWith(true, { discoverApi: true });
});

it('retains the last admitted model and thinking when optional account refresh fails on reopen', async () => {
  const account = {
    accountId: 'personal',
    accountLabel: 'Personal',
    provider: 'openai-codex' as const,
    model: 'first',
    profileRevision: 'fixture',
  };
  const meta = {
    sessionId: 'ordinary-retained-settings',
    cwd: '/offline/retained-task',
    repositoryWorkspaceId: 'workspace',
    accountBinding: account,
  };
  const runtime = {
    version: 2,
    account: {
      accountId: account.accountId,
      provider: account.provider,
      profileRevision: account.profileRevision,
    },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'fixture' },
  };
  const selection = {
    version: 1 as const,
    model: 'first',
    thinking: 'low',
    agent: { profileId: 'published', revision: 1 },
    context: { source: 'none' as const, revision: null },
    permission: { mode: 'agent' as const, revision: 0 },
  };
  store.admitOrdinaryLocalCommand(meta, runtime, {
    clientMsgId: 'settings-first',
    requestFingerprint: 'first',
    selection,
    payload: { text: 'First' },
  });
  store.claimOrdinaryLocalCommandDispatch('settings-first');
  store.completeOrdinaryLocalCommand('settings-first');
  store.admitOrdinaryLocalContinuation(
    { ...meta, accountBinding: { ...account, model: 'next' } },
    runtime,
    {
      clientMsgId: 'settings-next',
      requestFingerprint: 'next',
      selection: { ...selection, model: 'next', thinking: 'high' },
      payload: { text: 'Next' },
    },
  );
  catalog.refresh.mockRejectedValueOnce(Error('Optional catalogue unreadable'));
  const response = await request(server).get(
    '/api/sessions/ordinary-retained-settings/meta?refresh=1',
  );
  expect(response.status).toBe(200);
  expect(response.body.modelSelection).toEqual({
    model: 'next',
    reasoningEffort: 'high',
    models: [],
  });
  expect(response.body.accountBinding.model).toBe('first');
  expect(store.getSessionRuntimeBinding(meta.sessionId)).toEqual(runtime);
  const listed = await request(server).get('/api/sessions?limit=100');
  expect(listed.status).toBe(200);
  expect(
    listed.body.sessions.find((session: { id: string }) => session.id === meta.sessionId),
  ).toMatchObject({ model: 'next' });
  const readLatest = store.getLatestOrdinaryCommandAdmission.bind(store);
  const failedRead = vi
    .spyOn(store, 'getLatestOrdinaryCommandAdmission')
    .mockImplementation((id) => {
      if (id === meta.sessionId) throw Error('Private receipt read fixture');
      return readLatest(id);
    });
  try {
    const unavailable = await request(server).get('/api/sessions?limit=100');
    expect(unavailable.status).toBe(200);
    const retained = unavailable.body.sessions.find(
      (session: { id: string }) => session.id === meta.sessionId,
    );
    expect(retained).toHaveProperty('id', meta.sessionId);
    expect(retained).not.toHaveProperty('model');
    expect(retained).toMatchObject({ modelUnavailable: true, modelObservedAt: expect.any(Number) });
  } finally {
    failedRead.mockRestore();
  }
});

it('reads a pinned session’s recorded context by ID without catalog, runtime or list work', async () => {
  store.upsertSession({ sessionId: 'older-pin', summary: 'Older pin', inputTokens: 900000 });
  store.append('older-pin', 'token_update', {
    agentContext: 48000,
    sessionTotal: 900000,
    tokenLimits: { model: 'fixture', source: 'runtime', contextWindow: 200000 },
  });
  catalog.refresh.mockClear();
  const before = store.getLatestEvent('older-pin', 'token_update');
  const response = await request(server).get('/api/sessions/older-pin/context');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    sessionId: 'older-pin',
    contextUsage: {
      used: 48000,
      measuredAt: before!.createdAt,
      limits: { model: 'fixture', source: 'runtime', contextWindow: 200000, stale: false },
    },
  });
  expect(catalog.refresh).not.toHaveBeenCalled();
  expect(store.getLatestEvent('older-pin', 'token_update')).toEqual(before);
  store.upsertSession({ sessionId: 'no-measurement', inputTokens: 900000 });
  expect((await request(server).get('/api/sessions/no-measurement/context')).body).toEqual({
    sessionId: 'no-measurement',
    contextUsage: null,
  });
  store.hideSession('older-pin');
  expect((await request(server).get('/api/sessions/older-pin/context')).status).toBe(404);
  expect((await request(server).get('/api/sessions/missing/context')).status).toBe(404);
});

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express, NextFunction, Request, Response } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { EventStore } from '../event-store.js';
import { AccountProfiles } from '../account-profiles.js';
let currentAccounts: AccountProfiles;

vi.mock('../account-profiles.js', async (original) => ({
  ...(await original<object>()),
  loadAccountProfiles: () => currentAccounts,
}));
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  authMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  operatorAuthMiddleware: (req: Request, res: Response, next: NextFunction) => {
    if (req.header('x-operator') === 'browser') {
      res.locals.authSession = { id: 'operator', expiresAt: Date.now() + 60000 };
      return next();
    }
    res.status(403).json({ error: 'Interactive operator authentication is required' });
  },
}));
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: '0'.repeat(64),
  isValidInternalToken: () => false,
  isValidSignalCallbackToken: () => false,
  createSignalCallbackToken: vi.fn(),
  revokeSignalCallbackToken: vi.fn(),
}));

let app: Express;
let store: EventStore;
let root: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-output-app-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('TELOS_DB_PATH', join(root, 'todo.db'));
  vi.stubEnv('MCP_CONFIG_PATH', join(root, 'no-mcp.json'));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network in output fixture');
    }),
  );
  currentAccounts = new AccountProfiles([]);
  app = (await import('../app.js')).app;
  store = (await import('../chat.js')).eventStore;
  store.upsertSession({ sessionId: 'source', cwd: root });
  store.append('source', 'message_start', { messageId: 'reply' });
  store.append('source', 'block_start', {
    messageId: 'reply',
    blockId: 'draft',
    blockType: 'text',
  });
  store.append('source', 'block_delta', {
    messageId: 'reply',
    blockId: 'draft',
    delta: 'Exact useful draft',
  });
  store.append('source', 'block_end', { messageId: 'reply', blockId: 'draft', blockType: 'text' });
  store.append('source', 'message_end', { messageId: 'reply' });
}, 30_000);
afterAll(() => {
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('mounts existing-session collaboration links behind interactive auth without starting a provider', async () => {
  for (const sessionId of ['linked-local', 'linked-openshell'])
    store.upsertSession({ sessionId, conversationSource: 'mitzo' });
  const path = `/api/session-collaborations/${randomUUID()}`;
  const body = { expectedRevision: 0, participantSessionIds: ['linked-local', 'linked-openshell'] };
  expect(
    (await request(app).put(path).set('x-internal-token', 'internal-only').send(body)).status,
  ).toBe(403);
  const saved = await request(app).put(path).set('x-operator', 'browser').send(body);
  expect(saved.status).toBe(200);
  expect((await request(app).get(path).set('x-operator', 'browser')).body).toEqual({
    ...saved.body,
    unavailableParticipantSessionIds: [],
  });
  expect(store.getSessionEvents('linked-local')).toEqual([]);
  expect(store.getSessionRuntimeBinding('linked-local')).toBeNull();
});

it('mounts exact reference registration under interactive operator auth without converting the source chat', async () => {
  const initial = await request(app)
    .get('/api/sessions/source/outputs')
    .set('x-operator', 'browser');
  expect(initial.status).toBe(200);
  expect(initial.body.candidates[0].content).toBe('Exact useful draft');
  const saved = await request(app)
    .post('/api/sessions/source/outputs')
    .set('x-operator', 'browser')
    .send({
      requestId: 'one-registration',
      title: 'Useful draft',
      source: initial.body.candidates[0].source,
    });
  expect(saved.status).toBe(200);
  expect(saved.body.output.durability).toBe('reference_registered');
  expect(store.getSession('source')?.symposiumConfig).toBeNull();
  expect(
    (
      await request(app)
        .get('/api/sessions/source/outputs')
        .set('x-internal-token', 'internal-only')
    ).status,
  ).toBe(403);
  expect((await request(app).post('/api/sessions/source/contributors').send({})).status).toBe(403);
});

it('mounts contributor capability discovery without account fallback or provider execution', async () => {
  const response = await request(app)
    .get('/api/sessions/source/contributors')
    .set('x-operator', 'browser');
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    contributors: [],
    eligibility: { available: false, accountIds: [] },
  });
  expect(
    (await request(app).get('/api/sessions/missing/outputs').set('x-operator', 'browser')).status,
  ).toBe(404);
  const forged = await request(app)
    .post('/api/sessions/source/contributors')
    .set('x-operator', 'browser')
    .send({
      requestId: 'forged',
      accountId: 'caller-account',
      model: 'caller-model',
      label: 'Contributor',
      mode: 'agent',
      outputId: '00000000-0000-4000-8000-000000000000',
      outputRevision: 1,
      contextPackageDigest: '0'.repeat(64),
      authorityGrant: { filesystem: 'write' },
    });
  expect(forged.status).toBe(400);
  expect(store.getOutputContributorBindings('source')).toEqual([]);
});

it('composes same-account independent API contributors through ordinary account discovery without native Symposium setup', async () => {
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'offline-image');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', '/offline/policy.yaml');
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/offline/seed');
  currentAccounts = new AccountProfiles([
    {
      id: 'ordinary-api',
      label: 'Offline API',
      provider: 'openai',
      credentialRef: { provider: 'offline', service: 'unused', account: 'api' },
      sandboxProvider: 'offline-api',
      models: [{ id: 'offline-model', label: 'Offline' }],
    },
  ]);
  const base = '/api/sessions/source';
  const eligibility = await request(app).get(`${base}/contributors`).set('x-operator', 'browser');
  expect(eligibility.body.eligibility).toMatchObject({
    available: true,
    accountIds: ['ordinary-api'],
  });
  const listed = await request(app).get(`${base}/outputs`).set('x-operator', 'browser');
  const output = listed.body.outputs[0];
  const selected = await request(app)
    .get(`${base}/outputs/${output.outputId}`)
    .set('x-operator', 'browser');
  const input = {
    outputId: output.outputId,
    outputRevision: 1,
    contextPackageDigest: selected.body.contextPackageDigest,
    accountId: 'ordinary-api',
    model: 'offline-model',
    mode: 'agent',
    instructions: '',
  };
  const first = await request(app)
    .post(`${base}/contributors`)
    .set('x-operator', 'browser')
    .send({ ...input, requestId: 'composed-first', label: 'First' });
  const second = await request(app)
    .post(`${base}/contributors`)
    .set('x-operator', 'browser')
    .send({ ...input, requestId: 'composed-second', label: 'Second' });
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(second.body.contributor.id).not.toBe(first.body.contributor.id);
  expect(first.body.contributor.accountLabel).toBe('Offline API');
  expect(second.body.contributor.sessionId).toBeNull();
  const contributors = await request(app).get(`${base}/contributors`).set('x-operator', 'browser');
  expect(contributors.body.contributors).toHaveLength(2);
  expect(store.getSession('source')?.symposiumConfig).toBeNull();
  currentAccounts = new AccountProfiles([]);
});

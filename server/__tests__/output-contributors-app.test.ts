import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express, NextFunction, Request, Response } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventStore } from '../event-store.js';

vi.mock('../account-profiles.js', async (original) => ({
  ...(await original<object>()),
  loadAccountProfiles: () => ({ catalog: () => [], privateCodexRoots: () => [] }),
}));
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  authMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  operatorAuthMiddleware: (req: Request, res: Response, next: NextFunction) => {
    if (req.header('x-operator') === 'browser') return next();
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

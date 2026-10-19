import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import { TelosArtifactStore } from '../telos-artifact-store.js';
import request from 'supertest';
import {
  authenticateToken,
  login,
  operatorAuthMiddleware,
  setAuthRevocationStore,
} from '../auth.js';
import { createTelosSourceRouter } from '../telos-source-routes.js';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';

const close: Array<() => void> = [];
const revoked = new Set<string>();
setAuthRevocationStore({
  isAuthSessionRevoked: (session) => revoked.has(session.id),
  revokeAuthSession: (session) => {
    revoked.add(session.id);
  },
});
afterEach(() => {
  vi.restoreAllMocks();
  revoked.clear();
  close
    .splice(0)
    .reverse()
    .forEach((f) => f());
});
async function fixture() {
  const f = createTelosSourceApprovalData();
  close.push(() => f.close());
  for (let i = 0; i < 105; i++)
    f.artifacts.save({
      itemId: 'studio',
      filename: 'history.md',
      title: 'Exact history',
      bytes: Buffer.from('Revision ' + (i + 1)),
      sessionId: 'planning',
    });
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  const auth = (await authenticateToken(token))!;
  const app = express();
  app.use(express.json());
  app.use(
    createTelosSourceRouter({
      dbPath: () => f.dbPath,
      events: f.events,
      operatorAuth: operatorAuthMiddleware,
      ordinaryConversation: (id) => id === 'planning',
      createOutcome: f.createOutcome,
    }),
  );
  const pending = await f.request({ kind: 'create', marker: 'native' });
  const permId = String(pending.permId);
  const initial = await request(app)
    .get('/api/telos/work/source/permissions/' + permId)
    .query({ sessionId: 'planning' })
    .set('Authorization', 'Bearer ' + token);
  const pageInput = {
    sessionId: 'planning',
    toolUseId: initial.body.toolUseId,
    proposalSha256: initial.body.proposalSha256,
    after: JSON.stringify(initial.body.artifactCursor),
  };
  const get = (query: Record<string, unknown> = pageInput) =>
    request(app)
      .get('/api/telos/work/source/permissions/' + permId + '/materials')
      .query(query)
      .set('Authorization', 'Bearer ' + token);
  return { ...f, app, permId, token, auth, initial, pageInput, get };
}
it('serves bounded exact material metadata separately from message continuation through actual operator routes', async () => {
  const f = await fixture();
  expect(f.initial.status).toBe(200);
  expect(f.initial.body.messages.length).toBeGreaterThan(0);
  expect(f.initial.body.artifacts).toHaveLength(100);
  const before = f.retainedOwnerCounts();
  const next = await f.get();
  expect(next.status).toBe(200);
  expect(next.body.artifacts).toHaveLength(6);
  expect(next.body.hasMore).toBe(false);
  expect(next.body).toMatchObject({
    permId: f.permId,
    sessionId: 'planning',
    toolUseId: f.initial.body.toolUseId,
    proposalSha256: f.initial.body.proposalSha256,
  });
  expect(
    next.body.artifacts.every(
      (row: Record<string, unknown>) => !('bytes' in row) && !('contentBase64' in row),
    ),
  ).toBe(true);
  expect(f.retainedOwnerCounts()).toEqual(before);
});
it('rejects malformed/caller-authority cursor parameters and changed invocation binding', async () => {
  const f = await fixture();
  expect(f.initial.status).toBe(200);
  expect((await f.get({ ...f.pageInput, after: '{}' })).status).toBe(400);
  expect((await f.get({ ...f.pageInput, actor: 'operator:forged' })).status).toBe(400);
  expect((await f.get({ ...f.pageInput, permId: 'alternate-permission' })).status).toBe(400);
  expect((await f.get({ ...f.pageInput, toolUseId: 'replacement' })).status).toBe(409);
  expect((await f.get({ ...f.pageInput, proposalSha256: '0'.repeat(64) })).status).toBe(409);
});
it('does not treat a material cursor as authority after current login revocation', async () => {
  const f = await fixture();
  expect(f.initial.status).toBe(200);
  revoked.add(f.auth.id);
  const before = f.retainedOwnerCounts();
  expect([401, 403]).toContain((await f.get()).status);
  expect([401, 403]).toContain(
    (
      await request(f.app)
        .get('/api/telos/work/source/permissions/' + f.permId + '/materials')
        .query(f.pageInput)
    ).status,
  );
  expect(f.retainedOwnerCounts()).toEqual(before);
});

it('renews captured host authorization after material metadata is read and before returning it', async () => {
  const f = await fixture();
  expect(f.initial.status).toBe(200);
  const original = TelosArtifactStore.prototype.sourceMaterialPage;
  vi.spyOn(TelosArtifactStore.prototype, 'sourceMaterialPage').mockImplementation(function (
    this: TelosArtifactStore,
    ...args
  ) {
    const page = original.apply(this, args);
    revoked.add(f.auth.id);
    return page;
  });
  const response = await f.get();
  expect(response.status).toBe(403);
  expect(response.body.code).toBe('unauthorized');
  expect(response.body.artifacts).toBeUndefined();
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { SymposiumHostGrants } from '../symposium-host-grants.js';
import { createSymposiumDirectorRouter } from '../symposium-director-routes.js';
import { SymposiumConfigSchema, type SymposiumConfig } from '@mitzo/protocol';
let directory: string;
let store: EventStore;
let grants: SymposiumHostGrants;
let app: express.Express;
const binding = {
  accountId: 'approved',
  accountLabel: 'Approved',
  provider: 'openai-codex' as const,
  model: 'luna',
  profileRevision: 'binding-1',
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'config-receipt-route-'));
  const path = join(directory, 'events.db');
  store = new EventStore(path);
  store.upsertSession({ sessionId: 'session', accountBinding: binding });
  store.setSessionState('session', 'ENDED', { force: true });
  grants = new SymposiumHostGrants(path, {
    getConfig: (id) => {
      const raw = store.getSession(id)?.symposiumConfig;
      return raw ? SymposiumConfigSchema.parse(JSON.parse(raw)) : null;
    },
    commitConfig: (id, config, revision, operation) =>
      store.setSymposiumConfig(id, config, revision, operation),
    getMembership: () => null,
    validateSelection: () => {},
    authorizeSeat: () => ({
      classification: 'personal',
      sourceRefs: [],
      authority: { filesystem: 'read', tools: 'read', network: 'restricted' },
    }),
  });
  app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => {
    res.locals.authSession = { id: req.header('x-test-actor') ?? 'original' };
    next();
  });
  app.use(
    '/api/sessions/:id/symposium',
    createSymposiumDirectorRouter({
      store,
      getRuntime: () => ({}) as never,
      getSafetyOrchestrator: () => ({}) as never,
      validateSelection: () => {},
      validateActiveConfig: () => {},
      activateDraft: (input) => grants.activate(input),
      reviseSeat: (input) => grants.reviseSeat(input),
      resolveSelection: () => binding,
      getPerspective: () => ({ items: [], nextSeq: null }),
      getQueuedInputs: () => [],
    }),
  );
});
afterEach(() => {
  grants.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
const post = (suffix: string, body: Record<string, unknown>) =>
  request(app).post(`/api/sessions/session/symposium/${suffix}`).send(body);
const read = (key: string) =>
  request(app).get(`/api/sessions/session/symposium/configuration-operations/${key}`);
it('recovers exact draft and activation commits read-only, rejects wrong actor/payload, and replays without reminting grants', async () => {
  const draftBody = {
    idempotencyKey: 'draft-original',
    expectedRevision: 0,
    expectedAccountId: 'approved',
  };
  const draft = await post('draft', draftBody);
  expect(draft.status).toBe(200);
  expect((await read('draft-original')).body.receipt).toMatchObject({
    sessionId: 'session',
    actor: 'operator:original',
    action: 'draft',
    request: draftBody,
    config: draft.body,
  });
  const activation = {
    idempotencyKey: 'activation-original',
    expectedRevision: draft.body.revision,
    sharedBoundaryAcknowledged: true,
    contextSourceRefs: [],
  };
  const activate = vi.spyOn(grants, 'activate');
  const committed = await post('activate', activation);
  expect(committed.status).toBe(200);
  const proof = (await read('activation-original')).body.receipt;
  expect(proof).toMatchObject({ action: 'activate', request: activation, config: committed.body });
  expect((await post('activate', activation)).body).toEqual(committed.body);
  expect(activate).toHaveBeenCalledTimes(1);
  expect((await post('activate', { ...activation, contextSourceRefs: ['different'] })).status).toBe(
    409,
  );
  expect(
    (
      await request(app)
        .get('/api/sessions/session/symposium/configuration-operations/activation-original')
        .set('x-test-actor', 'other')
    ).status,
  ).toBe(403);
  expect((await read('unrelated')).body).toEqual({ receipt: null });
});
it('retains the exact revised seat snapshot with original approved payload after a lost response', async () => {
  await post('draft', { expectedRevision: 0, idempotencyKey: 'draft' });
  await post('activate', {
    expectedRevision: 1,
    sharedBoundaryAcknowledged: true,
    idempotencyKey: 'activate',
  });
  const body = {
    expectedRevision: 2,
    seatId: 'agent-original',
    name: 'Approved analyst',
    role: 'agent',
    systemPrompt: 'Read the approved files',
    expectedOutput: 'Findings',
    acceptanceCriteria: ['Evidence'],
    authorityRequest: { filesystem: 'read', tools: 'read', network: 'restricted' },
    color: '#665599',
    accountId: 'approved',
    model: 'luna',
    contextSourceRefs: [],
    sharedBoundaryAcknowledged: true,
    idempotencyKey: 'revise-original',
  };
  const revise = vi.spyOn(grants, 'reviseSeat');
  const committed = await post('seats/revise', body);
  expect(committed.status).toBe(200);
  const receipt = (await read('revise-original')).body.receipt;
  expect(receipt).toMatchObject({
    action: 'seats/revise',
    request: body,
    expectedRevision: 2,
    config: committed.body,
  });
  const seat = (receipt.config as SymposiumConfig).seats.find((row) => row.id === body.seatId);
  expect(seat).toMatchObject({
    model: body.model,
    systemPrompt: body.systemPrompt,
    expectedOutput: body.expectedOutput,
    acceptanceCriteria: body.acceptanceCriteria,
  });
  expect(seat?.authorityGrant?.grantId).toBeTruthy();
  expect((await post('seats/revise', body)).body).toEqual(committed.body);
  expect(revise).toHaveBeenCalledTimes(1);
  expect((await post('seats/revise', { ...body, systemPrompt: 'Changed approval' })).status).toBe(
    409,
  );
  expect(revise).toHaveBeenCalledTimes(1);
});

it('returns structured no-mutation proof when keyed receipt metadata exceeds its bound', async () => {
  await post('draft', { expectedRevision: 0 });
  await post('activate', { expectedRevision: 1, sharedBoundaryAcknowledged: true });
  const revise = vi.spyOn(grants, 'reviseSeat');
  const rejected = await post('seats/revise', {
    expectedRevision: 2,
    seatId: 'oversized',
    name: 'Analyst',
    role: 'agent',
    systemPrompt: 'x'.repeat(256 * 1024),
    color: '#665599',
    accountId: 'approved',
    model: 'luna',
    sharedBoundaryAcknowledged: true,
    idempotencyKey: 'oversized',
  });
  expect(rejected.status).toBe(400);
  expect(rejected.body.seatMutation).toBe('not-started');
  expect(revise).not.toHaveBeenCalled();
  expect(store.getSession('session')?.symposiumRevision).toBe(2);
  expect(store.getSymposiumConfigurationOperation('session', 'oversized')).toBeUndefined();
});

it('does not claim a new keyed operation committed merely because another operation saved the same config', async () => {
  await post('draft', { expectedRevision: 0 });
  const activated = await post('activate', {
    expectedRevision: 1,
    sharedBoundaryAcknowledged: true,
  });
  const result = await request(app).put('/api/sessions/session/symposium/config').send({
    expectedRevision: 1,
    idempotencyKey: 'unrelated-new-key',
    config: activated.body,
    sharedBoundaryAcknowledged: true,
  });
  expect(result.status).toBe(409);
  expect(result.body.seatMutation).toBe('not-started');
  expect(store.getSymposiumConfigurationOperation('session', 'unrelated-new-key')).toBeUndefined();
});

it.each(['original:stage', 'original%3Astage', 'original/stage', 'original stage'])(
  'rejects non-URL-portable configuration keys (%s) with definitive pre-mutation proof',
  async (idempotencyKey) => {
    const result = await post('draft', { expectedRevision: 0, idempotencyKey });
    expect(result.status).toBe(400);
    expect(result.body.seatMutation).toBe('not-started');
    expect(store.getSession('session')?.symposiumRevision).toBe(0);
    expect(store.getSymposiumConfigurationOperation('session', idempotencyKey)).toBeUndefined();
  },
);

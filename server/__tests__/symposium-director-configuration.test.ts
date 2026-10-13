import express, { Router } from 'express';
import request from 'supertest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SymposiumConfigSchema } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { SymposiumHostGrants } from '../symposium-host-grants.js';
import { createSymposiumDirectorRouter } from '../symposium-director-routes.js';
import {
  createSymposiumDirectorConfigurationHandlers,
  type SymposiumDirectorConfigurationDependencies,
} from '../symposium-director-configuration.js';
import { createConfigurationHandlersBeforeExtraction } from './fixtures/symposium-director-configuration-before-extraction.js';
import order from './fixtures/symposium-director-route-order.json';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';
vi.mock('../app.js', () => {
  throw Error('Application bootstrap imported');
});
vi.mock('../chat.js', () => {
  throw Error('Chat bootstrap imported');
});
const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const binding = {
  accountId: 'approved',
  accountLabel: 'Approved',
  provider: 'openai-codex' as const,
  model: 'offline-model',
  profileRevision: 'binding-1',
};
const reviseBody = {
  expectedRevision: 2,
  seatId: 'analyst',
  name: 'Analyst',
  role: 'agent',
  systemPrompt: 'Read evidence',
  color: '#665599',
  accountId: 'approved',
  model: binding.model,
  sharedBoundaryAcknowledged: true,
};
function fixture(before: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'director-configuration-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.db');
  const store = new EventStore(path);
  cleanups.push(() => store.close());
  store.upsertSession({ sessionId: 'session', accountBinding: binding });
  store.setSessionState('session', 'ENDED', { force: true });
  const grants = new SymposiumHostGrants(path, {
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
  cleanups.push(() => grants.close());
  const activate = vi.spyOn(grants, 'activate');
  const revise = vi.spyOn(grants, 'reviseSeat');
  const setConfig = vi.spyOn(store, 'setSymposiumConfig');
  const getSession = vi.spyOn(store, 'getSession');
  const getOperation = vi.spyOn(store, 'getSymposiumConfigurationOperation');
  const getRuntime = vi.fn(
    (): ReturnType<SymposiumDirectorConfigurationDependencies['getRuntime']> => ({}) as never,
  );
  const hasOrdinaryRuntime = vi.fn(() => false);
  const validateSelection = vi.fn();
  const validateActiveConfig = vi.fn();
  const resolveSelection = vi.fn((accountId: string, model: string) => ({
    ...binding,
    accountId,
    model,
  }));
  const deps: SymposiumDirectorConfigurationDependencies = {
    store,
    getRuntime,
    hasOrdinaryRuntime,
    validateSelection,
    validateActiveConfig,
    activateDraft: (input) => grants.activate(input),
    reviseSeat: (input) => grants.reviseSeat(input),
    resolveSelection,
  };
  const handlers = (
    before
      ? createConfigurationHandlersBeforeExtraction
      : createSymposiumDirectorConfigurationHandlers
  )(deps);
  const router = Router({ mergeParams: true });
  router.get('/configuration-operations/:key', handlers.operationReceipt);
  router.post('/seats/revise', handlers.reviseSeat);
  router.post('/activate', handlers.activate);
  router.post('/draft', handlers.draft);
  router.post('/selection', handlers.selection);
  router.put('/config', handlers.config);
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => {
    const actor = req.header('x-test-actor') ?? 'original';
    if (actor !== 'none') res.locals.authSession = { id: actor };
    next();
  });
  app.use('/api/sessions/:id/symposium', router);
  const send = (
    method: 'post' | 'put' | 'get',
    suffix: string,
    body = {},
    actor = 'original',
    id = 'session',
  ) => {
    const sent = request(app)
      [method](`/api/sessions/${id}/symposium/${suffix}`)
      .set('x-test-actor', actor);
    return method === 'get' ? sent : sent.send(body);
  };
  const post = (suffix: string, body = {}, actor = 'original') => send('post', suffix, body, actor);
  const read = (key: string, actor = 'original') =>
    send('get', `configuration-operations/${encodeURIComponent(key)}`, {}, actor);
  const config = () =>
    SymposiumConfigSchema.parse(JSON.parse(store.getSession('session')!.symposiumConfig!));
  const seedActive = async () => {
    expect((await post('draft', { expectedRevision: 0 })).status).toBe(200);
    expect(
      (await post('activate', { expectedRevision: 1, sharedBoundaryAcknowledged: true })).status,
    ).toBe(200);
  };
  return {
    app,
    store,
    grants,
    deps,
    handlers,
    getRuntime,
    hasOrdinaryRuntime,
    validateSelection,
    validateActiveConfig,
    resolveSelection,
    activate,
    revise,
    setConfig,
    getSession,
    getOperation,
    post,
    send,
    read,
    config,
    seedActive,
  };
}

describe.each([true, false])('configuration family (before=%s)', (before) => {
  it('constructs handlers without resolving authority, runtime or stored session inputs', () => {
    const f = fixture(before);
    expect(Object.keys(f.handlers)).toEqual([
      'operationReceipt',
      'reviseSeat',
      'activate',
      'draft',
      'selection',
      'config',
    ]);
    expect(f.getRuntime).not.toHaveBeenCalled();
    expect(f.getSession).not.toHaveBeenCalled();
    expect(f.getOperation).not.toHaveBeenCalled();
    expect(f.resolveSelection).not.toHaveBeenCalled();
  });
  it.each(['draft', 'activate', 'seats/revise', 'config'] as const)(
    'replays %s before live gates, rejects actor/payload drift and keeps the original receipt',
    async (action) => {
      const f = fixture(before);
      let body: Record<string, unknown> = { expectedRevision: 0, expectedAccountId: 'approved' };
      if (action !== 'draft')
        expect((await f.post('draft', { expectedRevision: 0 })).status).toBe(200);
      if (action === 'seats/revise') {
        expect(
          (await f.post('activate', { expectedRevision: 1, sharedBoundaryAcknowledged: true }))
            .status,
        ).toBe(200);
        body = { ...reviseBody };
      } else if (action === 'activate')
        body = { expectedRevision: 1, sharedBoundaryAcknowledged: true };
      else if (action === 'config')
        body = { expectedRevision: 1, config: { ...f.config(), revision: 2 } };
      body.idempotencyKey = 'original-operation';
      const send = (value: Record<string, unknown>, actor = 'original') =>
        f.send(action === 'config' ? 'put' : 'post', action, value, actor);
      const first = await send(body);
      expect(first.status).toBe(200);
      const receipt = (await f.read('original-operation')).body.receipt;
      expect(receipt).toMatchObject({
        actor: 'operator:original',
        action,
        request: body,
        config: first.body,
      });
      const writes = f.setConfig.mock.calls.length;
      const activations = f.activate.mock.calls.length;
      const revisions = f.revise.mock.calls.length;
      f.getRuntime.mockClear();
      f.getRuntime.mockReturnValue(null);
      f.hasOrdinaryRuntime.mockReturnValue(true);
      f.resolveSelection.mockImplementation(() => {
        throw Error('Catalog now unavailable');
      });
      expect((await send(Object.fromEntries(Object.entries(body).reverse()))).body).toEqual(
        first.body,
      );
      expect((await send(body, 'other')).status).toBe(403);
      expect(
        (await send({ ...body, expectedRevision: Number(body.expectedRevision) + 1 })).body,
      ).toEqual({ error: 'Configuration operation key conflict' });
      expect(f.getRuntime).not.toHaveBeenCalled();
      expect(f.setConfig).toHaveBeenCalledTimes(writes);
      expect(f.activate).toHaveBeenCalledTimes(activations);
      expect(f.revise).toHaveBeenCalledTimes(revisions);
      expect((await f.read('original-operation', 'other')).status).toBe(403);
      expect((await f.read('original-operation')).body.receipt).toEqual(receipt);
      f.getOperation.mockImplementation(() => {
        throw Error('Proof unavailable');
      });
      const unavailable = await send(body);
      expect(unavailable.status).toBe(409);
      expect(unavailable.body).toEqual({ error: 'Configuration operation proof is unavailable' });
      expect(f.setConfig).toHaveBeenCalledTimes(writes);
    },
  );
  it('retains actor fallback, read-only absent receipts and session/key validation', async () => {
    const f = fixture(before);
    expect(
      (await f.post('draft', { expectedRevision: 0, idempotencyKey: 'fallback' }, 'none')).status,
    ).toBe(200);
    expect((await f.read('fallback', 'none')).body.receipt.actor).toBe('internal-operator');
    expect((await f.read('fallback')).status).toBe(403);
    expect((await f.read('unknown')).body).toEqual({ receipt: null });
    expect((await f.read('not portable')).status).toBe(400);
    expect(
      (await f.send('get', 'configuration-operations/unknown', {}, 'original', 'missing')).status,
    ).toBe(404);
  });
  it('refuses oversized operation metadata before runtime or grant entry', async () => {
    const f = fixture(before);
    await f.seedActive();
    f.getRuntime.mockClear();
    const response = await f.post('seats/revise', {
      ...reviseBody,
      systemPrompt: 'x'.repeat(256 * 1024),
      idempotencyKey: 'oversized',
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Invalid configuration operation identity or size',
      seatMutation: 'not-started',
    });
    expect(f.getRuntime).not.toHaveBeenCalled();
    expect(f.revise).not.toHaveBeenCalled();
    expect(f.store.getSymposiumConfigurationOperation('session', 'oversized')).toBeUndefined();
  });
  it('does not confuse a new key with the legacy identical-config retry', async () => {
    const f = fixture(before);
    await f.seedActive();
    f.getRuntime.mockClear();
    f.getRuntime.mockReturnValue(null);
    f.setConfig.mockClear();
    const config = f.config();
    expect((await f.send('put', 'config', { expectedRevision: 999, config })).body).toEqual(config);
    expect(f.getRuntime).not.toHaveBeenCalled();
    const keyed = await f.send('put', 'config', {
      expectedRevision: 999,
      config,
      idempotencyKey: 'not-committed',
    });
    expect(keyed.status).toBe(409);
    expect(keyed.body.seatMutation).toBe('not-started');
    expect(f.store.getSymposiumConfigurationOperation('session', 'not-committed')).toBeUndefined();
    expect(f.setConfig).not.toHaveBeenCalled();
  });
  it('checks draft revisions, conversation accounts and live ordinary activity before conversion', async () => {
    const f = fixture(before);
    expect((await f.post('draft', { expectedRevision: 1 })).body.error).toBe(
      'Draft revision conflict',
    );
    expect((await f.post('draft', { expectedAccountId: 'other' })).body.error).toBe(
      'Conversation account changed before draft creation',
    );
    f.hasOrdinaryRuntime.mockReturnValue(true);
    expect((await f.post('draft', { expectedRevision: 0 })).body.seatMutation).toBe('not-started');
    expect(f.setConfig).not.toHaveBeenCalled();
    f.hasOrdinaryRuntime.mockReturnValue(false);
    const result = await f.post('draft', { expectedRevision: 0, expectedAccountId: 'approved' });
    expect(result.status).toBe(200);
    expect(result.body.seats[0].accountBinding).toEqual(binding);
  });
  it('requires shared and typed cross-account confirmation before activating host grants', async () => {
    const f = fixture(before);
    await f.post('draft', { expectedRevision: 0 });
    const draft = f.config();
    f.store.setSymposiumConfig(
      'session',
      {
        ...draft,
        revision: 2,
        seats: [
          ...draft.seats,
          {
            ...draft.seats[0],
            id: 'other-seat',
            accountBinding: { ...binding, accountId: 'other' },
          },
        ],
      },
      1,
    );
    f.getRuntime.mockClear();
    const invalid = await f.post('activate', { expectedRevision: 2 });
    expect(invalid.status).toBe(409);
    expect(invalid.body.activationMutation).toBe('not-started');
    expect(f.getRuntime).not.toHaveBeenCalled();
    const body = { expectedRevision: 2, sharedBoundaryAcknowledged: true };
    expect((await f.post('activate', body)).body.error).toBe(
      'Typed cross-account seat confirmation is required',
    );
    expect(f.activate).not.toHaveBeenCalled();
    expect(
      (await f.post('activate', { ...body, crossAccountConfirmation: 'ADD CROSS-ACCOUNT SEAT' }))
        .status,
    ).toBe(200);
  });
  it('preserves anchor identity and inherited guidance when older seat editors omit optional fields', async () => {
    const f = fixture(before);
    await f.seedActive();
    const denied = await f.post('seats/revise', {
      ...reviseBody,
      seatId: 'architect',
      accountId: 'other',
    });
    expect(denied.body).toEqual({
      error: 'Anchor must retain the conversation account',
      seatMutation: 'not-started',
    });
    expect(f.revise).not.toHaveBeenCalled();
    const guidance = {
      expectedOutput: 'Findings',
      acceptanceCriteria: ['Evidence'],
      authorityRequest: { filesystem: 'read', tools: 'read', network: 'restricted' },
    };
    expect((await f.post('seats/revise', { ...reviseBody, ...guidance })).status).toBe(200);
    const second = await f.post('seats/revise', {
      ...reviseBody,
      expectedRevision: 3,
      role: 'reviewer',
    });
    expect(second.status).toBe(200);
    expect(f.revise.mock.calls.at(-1)?.[0].seat).toMatchObject(guidance);
    expect(f.revise.mock.calls.at(-1)?.[0].seat).not.toHaveProperty('authorityGrant');
  });
  it('preserves bound-seat validation and host grant validation before active persistence', async () => {
    const f = fixture(before);
    await f.seedActive();
    f.setConfig.mockClear();
    const input = {
      expectedRevision: 2,
      config: { ...f.config(), revision: 3 },
      sharedBoundaryAcknowledged: true,
    };
    f.validateSelection.mockImplementation(() => {
      throw Error('Model refused');
    });
    expect((await f.send('put', 'config', input)).body).toEqual({
      error: 'Model refused',
      seatMutation: 'not-started',
    });
    expect(f.validateActiveConfig).not.toHaveBeenCalled();
    expect(f.setConfig).not.toHaveBeenCalled();
    f.validateSelection.mockReset();
    f.validateActiveConfig.mockImplementation(() => {
      throw Error('Grant refused');
    });
    expect((await f.send('put', 'config', input)).body).toEqual({
      error: 'Grant refused',
      seatMutation: 'not-started',
    });
    expect(f.setConfig).not.toHaveBeenCalled();
    f.validateActiveConfig.mockReset();
    f.setConfig.mockImplementation(() => {
      throw Error('Unknown write result');
    });
    expect((await f.send('put', 'config', input)).body).toEqual({ error: 'Unknown write result' });
  });
  it('rejects invalid bodies and fabricated draft grants without entering mutation owners', async () => {
    const f = fixture(before);
    expect((await f.post('draft', { idempotencyKey: 'missing-revision' })).status).toBe(400);
    expect(
      (
        await f.post('selection', {
          accountId: 'approved',
          model: binding.model,
          credentialRef: 'private',
        })
      ).status,
    ).toBe(400);
    expect(
      (await f.post('selection', { accountId: 'approved', model: binding.model })).body,
    ).toEqual({ binding });
    await f.post('draft', { expectedRevision: 0 });
    const config = f.config();
    const invalid = {
      ...config,
      revision: 2,
      seats: config.seats.map((seat) => ({
        ...seat,
        profileBinding: { profileId: 'fabricated', profileRevision: '1' },
      })),
    };
    f.setConfig.mockClear();
    expect((await f.send('put', 'config', { expectedRevision: 1, config: invalid })).body).toEqual({
      error: 'Draft seats cannot supply runtime grants',
      seatMutation: 'not-started',
    });
    expect(f.setConfig).not.toHaveBeenCalled();
  });
});

it('pins the owner and retains the full Director route order with direct handler registrations', () => {
  const f = fixture(false);
  const router = createSymposiumDirectorRouter({
    ...f.deps,
    getSafetyOrchestrator: () => ({}) as never,
    getPerspective: () => ({ items: [], nextSeq: null }),
    getQueuedInputs: () => [],
  });
  const routes = router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({ method: Object.keys(layer.route.methods)[0], path: layer.route.path }));
  expect(routes).toEqual(order.routes);
  const source = readFileSync(
    new URL('../symposium-director-configuration.ts', import.meta.url),
    'utf8',
  );
  const pins: Record<string, string> = reviewedHandlerSourceArtifacts;
  expect(pins['../symposium-director-configuration.ts']).toBe(
    reviewedHandlerSourceFingerprint(source),
  );
  const parent = readFileSync(new URL('../symposium-director-routes.ts', import.meta.url), 'utf8');
  for (const [method, path, handler] of [
    ['get', '/configuration-operations/:key', 'operationReceipt'],
    ['post', '/seats/revise', 'reviseSeat'],
    ['post', '/activate', 'activate'],
    ['post', '/draft', 'draft'],
    ['post', '/selection', 'selection'],
    ['put', '/config', 'config'],
  ])
    expect(parent).toContain(`router.${method}('${path}', configuration.${handler});`);
  expect(parent.match(/createSymposiumDirectorConfigurationHandlers\(deps\)/g)).toHaveLength(1);
});

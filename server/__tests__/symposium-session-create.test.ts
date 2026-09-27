import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import request from 'supertest';
import { EventStore } from '../event-store.js';
import { AccountProfiles } from '../account-profiles.js';
import { SymposiumProfileStore } from '../symposium-profiles.js';
import { createSymposiumSessionRouter } from '../symposium-session-create.js';
import { login, operatorAuthMiddleware } from '../auth.js';
import { INTERNAL_TOKEN } from '../internal-token.js';

let root: string;
let store: EventStore;
let profiles: SymposiumProfileStore;
let app: express.Express;
let token: string;
const accounts = new AccountProfiles([
  {
    id: 'work',
    label: 'Owned work',
    provider: 'openai',
    credentialRef: { provider: 'keychain', service: 'mock', account: 'work' },
    sandboxProvider: 'owned-provider',
    sandboxProviderId: 'owned-id',
    models: [{ id: 'gpt-5.6-luna', label: 'Luna' }],
  },
]);
const body = {
  idempotencyKey: 'create-one',
  title: 'Review work',
  accountId: 'work',
  model: 'gpt-5.6-luna',
  reasoningEffort: null,
  role: 'coder',
  profileSelection: { profileId: 'builder', revision: 1 },
};
const currentAccounts = vi.fn(() => accounts);
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'symposium-create-'));
  store = new EventStore(join(root, 'events.db'));
  profiles = new SymposiumProfileStore(join(root, 'events.db'));
  profiles.save('user', {
    profileId: 'builder',
    expectedRevision: 0,
    idempotencyKey: 'seed',
    definition: {
      name: 'Builder',
      role: 'coder',
      instructions: 'Implement reviewed edits',
      expectedOutput: 'Tested patch',
      acceptanceCriteria: ['Tests pass'],
      modelPolicyRole: 'coder',
    },
  });
  currentAccounts.mockReset().mockReturnValue(accounts);
  app = express();
  app.use(express.json());
  app.use(
    '/sessions',
    operatorAuthMiddleware,
    createSymposiumSessionRouter({
      store,
      profiles,
      currentAccounts,
      newSessionId: () => 'allocated',
    }),
  );
  token = (await login(process.env.AUTH_PASSPHRASE!))!;
});
afterEach(() => {
  store.close();
  profiles.close();
  rmSync(root, { recursive: true, force: true });
});
const post = (data: object = body) =>
  request(app).post('/sessions').set('Authorization', `Bearer ${token}`).send(data);
it('requires an operator login and rejects internal-token callers', async () => {
  expect((await request(app).post('/sessions').send(body)).status).toBe(403);
  expect(
    (await request(app).post('/sessions').set('x-internal-token', INTERNAL_TOKEN).send(body))
      .status,
  ).toBe(403);
  expect(store.listSessions()).toHaveLength(0);
});
it('allocates an idle durable draft without any provider execution and retries after restart', async () => {
  const first = await post();
  expect(first.status).toBe(201);
  expect(first.body).toEqual({ sessionId: 'allocated', created: true });
  const session = store.getSession('allocated')!;
  expect(session.isActive).toBe(false);
  expect(session.accountBinding).toEqual(accounts.resolve('work', 'gpt-5.6-luna', true));
  const config = JSON.parse(session.symposiumConfig!);
  expect(config).toMatchObject({
    version: 2,
    state: 'draft',
    anchorSeatId: 'primary',
    seats: [{ role: 'coder', name: 'Builder' }],
  });
  expect(store.getSymposiumInitialProfileSelections('allocated')).toEqual({
    primary: { profileId: 'builder', revision: 1 },
  });
  expect(store.getSymposiumMembershipHistory('allocated')).toEqual([]);
  expect(store.getSymposiumAdmissions('allocated')).toEqual([]);
  expect(store.getSymposiumDeliveries('allocated')).toEqual([]);
  expect(store.getSessionEvents('allocated')).toEqual([]);
  store.close();
  store = new EventStore(join(root, 'events.db'));
  app = express();
  app.use(express.json());
  app.use(
    '/sessions',
    operatorAuthMiddleware,
    createSymposiumSessionRouter({ store, profiles, currentAccounts }),
  );
  currentAccounts.mockImplementation(() => {
    throw new Error('Host unavailable');
  });
  expect((await post()).body).toEqual({ sessionId: 'allocated', created: false });
  expect(store.listSessions()).toHaveLength(1);
  expect((await post({ ...body, title: 'Changed request' })).status).toBe(409);
});
it('fails unsupported, missing and stale catalog selections without allocating anything', async () => {
  for (const change of [
    { accountId: 'absent' },
    { model: 'unsupported' },
    { role: 'architect' },
    { role: 'reviewer' },
    { profileSelection: { profileId: 'builder', revision: 2 } },
    { owner: 'other' },
  ])
    expect((await post({ ...body, ...change })).status).toBeGreaterThanOrEqual(400);
  currentAccounts.mockReturnValue(new AccountProfiles([]));
  expect((await post()).status).toBe(409);
  expect(store.listSessions()).toHaveLength(0);
});
it('rolls back session and retry receipt if draft persistence fails', async () => {
  const original = store.setSymposiumConfig.bind(store);
  vi.spyOn(store, 'setSymposiumConfig').mockImplementationOnce(() => {
    throw new Error('injected database failure');
  });
  expect((await post()).status).toBe(409);
  expect(store.getSession('allocated')).toBeNull();
  store.setSymposiumConfig = original;
  expect((await post()).status).toBe(201);
});

it('accepts the exact cached catalog model without refreshing or reverting to configured seeds', async () => {
  const { refreshModels } = await import('../model-catalog.js');
  const profile = {
    id: 'cached-work',
    label: 'Cached owned work',
    provider: 'openai' as const,
    credentialRef: { provider: 'keychain', service: 'cached-test', account: 'work' },
    sandboxProvider: 'cached-provider',
    sandboxProviderId: 'cached-provider-id',
    models: [{ id: 'gpt-5.6-luna', label: 'Configured seed' }],
  };
  const cached = new AccountProfiles([profile]);
  const discover = vi
    .fn()
    .mockResolvedValue([{ id: 'gpt-6-luna', label: 'Cached Luna', reasoningEfforts: ['low'] }]);
  await refreshModels(JSON.stringify(profile), discover, true);
  expect(cached.catalog()[0].models[0].id).toBe('gpt-6-luna');
  currentAccounts.mockReturnValue(cached);
  const refresh = vi.spyOn(cached, 'refresh');
  const created = await post({
    ...body,
    accountId: profile.id,
    model: 'gpt-6-luna',
    reasoningEffort: 'low',
  });
  expect(created.status).toBe(201);
  expect(store.getSession('allocated')?.accountBinding?.model).toBe('gpt-6-luna');
  expect(discover).toHaveBeenCalledTimes(1);
  expect(refresh).not.toHaveBeenCalled();
  expect(
    (
      await post({
        ...body,
        idempotencyKey: 'wrong-effort',
        accountId: profile.id,
        model: 'gpt-6-luna',
        reasoningEffort: 'unsupported',
      })
    ).status,
  ).toBe(409);
  expect((await post({ ...body, idempotencyKey: 'old-seed', accountId: profile.id })).status).toBe(
    409,
  );
});

it('keeps a draft usable when provisioning fails and retries only that session', async () => {
  const ensureSessionArtifacts = vi
    .fn()
    .mockRejectedValueOnce(new Error('driver unavailable'))
    .mockResolvedValue({ state: 'ready' });
  app = express();
  app.use(express.json());
  app.use(
    '/sessions',
    operatorAuthMiddleware,
    createSymposiumSessionRouter({
      store,
      profiles,
      currentAccounts,
      newSessionId: () => 'allocated',
      ensureSessionArtifacts,
    }),
  );
  const first = await post();
  expect(first.status).toBe(201);
  expect(first.body.artifacts).toEqual({ state: 'recovery_required' });
  expect(store.getSession('allocated')?.isActive).toBe(false);
  expect(
    (
      await request(app)
        .post('/sessions/missing/artifacts')
        .set('Authorization', `Bearer ${token}`)
        .send({})
    ).status,
  ).toBe(404);
  expect(ensureSessionArtifacts).toHaveBeenCalledTimes(1);
  const result = await request(app)
    .post('/sessions/allocated/artifacts')
    .set('Authorization', `Bearer ${token}`)
    .send({});
  expect(result.body).toEqual({ state: 'ready' });
  expect(ensureSessionArtifacts).toHaveBeenLastCalledWith('allocated');
  expect(
    (
      await request(app)
        .post('/sessions/allocated/artifacts')
        .set('Authorization', `Bearer ${token}`)
        .send({ volumeName: 'injected' })
    ).status,
  ).toBe(400);
  expect(ensureSessionArtifacts).toHaveBeenCalledTimes(2);
});
it('does not hand a replacement controller active membership when loss races artifact initialization', async () => {
  const { SymposiumCustodianController } = await import('../symposium-custodian-controller.js');
  const { dispatchCustodianHttp } = await import('../symposium-custodian-http.js');
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const physical = new Promise<void>((resolve) => {
    release = resolve;
  });
  const retained = new Set<string>();
  app = express();
  app.use(express.json());
  app.use(
    '/api/symposium/sessions',
    operatorAuthMiddleware,
    createSymposiumSessionRouter({
      store,
      profiles,
      currentAccounts,
      newSessionId: () => 'allocated',
      onSessionCreated: (id) => retained.add(id),
      ensureSessionArtifacts: async () => {
        started();
        await physical;
        return { state: 'ready' };
      },
    }),
  );
  const controller = new SymposiumCustodianController({
    pause() {},
    resume() {},
    invalidate() {},
    drain: async () => {
      await physical;
    },
    dispatch: (command, assert) => dispatchCustodianHttp(app, command, assert),
  });
  const first = controller.attach();
  const pending = first.request({
    epoch: first.epoch,
    requestId: 'create',
    operation: 'session.create',
    body,
    query: {},
    authorization: { id: 'actual-test-jti', expiresAt: Date.now() + 10000 },
  });
  const rejected = expect(pending).rejects.toThrow('controller');
  await entered;
  const lost = first.lost();
  expect(() => controller.attach()).toThrow('cleanup');
  expect(retained.has('allocated')).toBe(true);
  release();
  await rejected;
  await lost;
  expect(controller.attach().epoch).toBe(2);
  expect(JSON.parse(store.getSession('allocated')!.symposiumConfig!).state).toBe('draft');
  expect(store.getSymposiumMembershipHistory('allocated')).toEqual([]);
});

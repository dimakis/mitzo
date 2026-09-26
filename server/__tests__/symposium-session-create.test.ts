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

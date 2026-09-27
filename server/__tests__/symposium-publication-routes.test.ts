import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createPublicationRouter } from '../symposium-publication-routes.js';
import { PublicationRegistration } from '../symposium-publication-registration.js';
import { CredentialResolver } from '../credentials.js';
import { CapabilityOperationStore } from '../connections/capabilities/operation-store.js';
const signal = new AbortController().signal;
it('registers metadata without credential resolution, authenticates selection and fences logout', async () => {
  const resolve = vi.fn(async () => 'secret-value');
  const run = vi.fn(async () => ({
    stdout: JSON.stringify({ id: 1, login: 'operator', type: 'User' }),
  }));
  const operations = new CapabilityOperationStore(':memory:');
  const registration = new PublicationRegistration({
    authorityPath: ':memory:',
    operations,
    credentials: [
      {
        id: 'write',
        label: 'Write connection',
        reference: { provider: 'test', service: 'git', account: 'user' },
      },
    ],
    resolver: new CredentialResolver({ test: { resolve } }),
    runner: run,
    artifact: {
      require: async () => ({
        workspace: '/artifact',
        repositoryPath: '/artifact',
        sourceOid: 'a'.repeat(40),
      }),
      inspectCompletedArtifact: vi.fn(),
      exportCompletedArtifactBundle: vi.fn(),
    },
  });
  expect(resolve).not.toHaveBeenCalled();
  const app = express();
  app.use(express.json());
  let authenticated = false;
  app.use((_req, res, next) => {
    if (authenticated) res.locals.authSession = { id: 'login', expiresAt: Date.now() + 60_000 };
    next();
  });
  app.use(
    '/sessions/:id/publication',
    createPublicationRouter({
      registration: () => registration,
      hasSession: (id) => id === 'session',
      approval: () => undefined,
    }),
  );
  expect((await request(app).get('/sessions/session/publication')).status).toBe(401);
  authenticated = true;
  expect(
    (await request(app).get('/sessions/session/publication')).body.credentials[0].selected,
  ).toBe(false);
  const selected = await registration.custodian.select('write', 1);
  registration.authorize({ id: 'login', expiresAt: Date.now() + 60_000 });
  const scope = {
    operatorId: 'login',
    sessionId: 'session',
    recordId: 'record',
    recordHash: 'a'.repeat(64),
    sealId: 'seal',
    sealHash: 'b'.repeat(64),
    repository: 'owner/repo',
    connectionId: 'write',
    connectionRevision: 1,
    credentialGeneration: selected.generation,
  };
  const principal = await registration.authority.preview(scope, signal);
  const grant = await registration.authority.grant(scope, principal, signal);
  const before = run.mock.calls.length;
  expect(
    (
      await request(app).post('/sessions/session/publication/publish').send({
        grantId: grant.id,
        bindingHash: grant.bindingHash,
        turnId: 'turn',
        idempotencyKey: 'key',
        baseBranch: 'main',
        title: 'PR',
        body: 'body',
        draft: true,
      })
    ).status,
  ).toBe(409);
  expect(run.mock.calls.length).toBe(before); // no authenticated controller approval owner
  expect(
    (
      await request(app)
        .post('/sessions/session/publication/select')
        .set('Origin', 'https://foreign.invalid')
        .send({ connectionId: 'write', revision: 1 })
    ).status,
  ).toBe(403);
  registration.invalidate('login');
  await expect(registration.authority.require(grant.id, grant.bindingHash, signal)).rejects.toThrow(
    'operator',
  );
  registration.shutdown();
  expect(() => registration.authorize({ id: 'new-login', expiresAt: Date.now() + 60000 })).toThrow(
    'shutting down',
  );
  registration.close();
  operations.close();
});

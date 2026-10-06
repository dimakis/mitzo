import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
it('creates grant custody beneath a normal workspace directory without changing its mode', async () => {
  const { mkdtempSync, mkdirSync, statSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { publicationAuthorityPath } = await import('../symposium-publication-registration.js');
  const root = mkdtempSync(join(tmpdir(), 'publication-registration-'));
  const directory = join(root, '.mitzo');
  mkdirSync(directory, { mode: 0o755 });
  const path = publicationAuthorityPath(directory);
  expect(statSync(directory).mode & 0o777).toBe(0o755);
  expect(statSync(join(directory, 'publication')).mode & 0o777).toBe(0o700);
  const operations = new CapabilityOperationStore(':memory:');
  const registration = new PublicationRegistration({
    authorityPath: path,
    operations,
    credentials: [],
    artifact: {
      require: vi.fn(),
      inspectCompletedArtifact: vi.fn(),
      exportCompletedArtifactBundle: vi.fn(),
    },
  });
  expect(registration.service.availability().available).toBe(false);
  registration.close();
  operations.close();
  rmSync(root, { recursive: true, force: true });
});
it('rechecks pending publication after awaited grant reads and before persisting a grant', async () => {
  let reached!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'publication-grant-overlap-')));
  const authorityPath = join(directory, 'authority.db');
  const operations = new CapabilityOperationStore(':memory:');
  const registration = new PublicationRegistration({
    authorityPath,
    operations,
    credentials: [
      {
        id: 'write',
        label: 'Write',
        reference: { provider: 'test', service: 'git', account: 'user' },
      },
    ],
    resolver: new CredentialResolver({ test: { resolve: async () => 'fixture-only' } }),
    runner: async () => ({ stdout: JSON.stringify({ id: 1, login: 'operator', type: 'User' }) }),
    artifact: {
      require: async () => {
        reached();
        await resume;
        return { workspace: '/artifact', repositoryPath: '/artifact', sourceOid: 'a'.repeat(40) };
      },
      inspectCompletedArtifact: vi.fn(),
      exportCompletedArtifactBundle: vi.fn(),
    },
  });
  const guard = vi.spyOn(registration.service, 'assertPublicationAvailable');
  try {
    const selected = await registration.custodian.select('write', 1);
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.authSession = { id: 'login', expiresAt: Date.now() + 60_000 };
      next();
    });
    app.use(
      '/sessions/:id/publication',
      createPublicationRouter({
        registration: () => registration,
        hasSession: () => true,
        approval: () => undefined,
      }),
    );
    const result = request(app)
      .post('/sessions/session/publication/grant')
      .send({
        selection: {
          recordId: 'record',
          recordHash: 'a'.repeat(64),
          sealId: 'seal',
          sealHash: 'b'.repeat(64),
          repository: 'owner/repo',
          connectionId: 'write',
          connectionRevision: 1,
          credentialGeneration: selected.generation,
        },
        principal: { host: 'github.com', numericId: 1, login: 'operator' },
      })
      .then((response) => response);
    await reading;
    expect(guard).toHaveBeenCalledOnce();
    operations.upsertGrant({
      id: 'retained-grant',
      connectionId: 'sealed-publication-retained-owner',
      connectionRevision: 1,
      capabilityId: 'github.publish-pr',
      capabilityVersion: 1,
      accountIds: ['operator:login'],
      status: 'active',
    });
    const pending = operations.begin({
      connectionId: 'sealed-publication-retained-owner',
      connectionRevision: 1,
      capabilityId: 'github.publish-pr',
      capabilityVersion: 1,
      grantId: 'retained-grant',
      accountId: 'operator:login',
      conversationId: 'session',
      turnId: 'prior-turn',
      idempotencyKey: 'prior-key',
      inputHash: 'c'.repeat(64),
      approvalInput: null,
      approvalHash: null,
      recoveryIntent: null,
    }).operation;
    operations.transition(pending.id, 'pending_approval', 'verification_pending');
    release();
    expect((await result).status).toBe(409);
    expect(guard).toHaveBeenCalledTimes(2);
    const db = new Database(authorityPath, { readonly: true });
    try {
      expect(db.prepare('SELECT count(*) AS count FROM sealed_publication_grants').get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
    }
  } finally {
    release();
    registration.close();
    operations.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
it('resolves publication suggestions only from successful controller-derived artifact publications', async () => {
  const completed = vi.fn();
  const result = { id: 'operation', status: 'succeeded' };
  const runtime = {
    authorize: () => signal,
    authority: {
      require: async () => ({ grant: { scope: { operatorId: 'login', sessionId: 'session' } } }),
    },
    artifact: { require: async () => ({ repositoryPath: '/sealed-artifact' }) },
    service: { invoke: vi.fn(async () => result) },
  } as unknown as PublicationRegistration;
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authSession = { id: 'login', expiresAt: Date.now() + 60000 };
    next();
  });
  app.use(
    '/sessions/:id/publication',
    createPublicationRouter({
      registration: () => runtime,
      hasSession: (id) => id === 'session',
      approval: () => async () => true,
      onPublicationCompleted: completed,
    }),
  );
  const input = {
    grantId: 'grant',
    bindingHash: 'a'.repeat(64),
    turnId: 'turn',
    idempotencyKey: 'key',
    baseBranch: 'main',
    title: 'PR',
    body: '',
    draft: true,
  };
  expect(
    (await request(app).post('/sessions/session/publication/publish').send(input)).status,
  ).toBe(200);
  expect(completed).toHaveBeenCalledWith(
    'session',
    expect.objectContaining({ repositoryPath: '/sealed-artifact', baseBranch: 'main' }),
    result,
  );
  completed.mockClear();
  result.status = 'verification_pending';
  expect(
    (await request(app).post('/sessions/session/publication/publish').send(input)).status,
  ).toBe(200);
  expect(completed).not.toHaveBeenCalled();
  result.status = 'succeeded';
  completed.mockImplementation(() => {
    throw Error('Advisory cleanup unavailable');
  });
  expect(
    (await request(app).post('/sessions/session/publication/publish').send(input)).status,
  ).toBe(200);
});

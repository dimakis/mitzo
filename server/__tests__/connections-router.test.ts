import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectionStore } from '../connections-store.js';
import { RevisionConflictError } from '../connections-store.js';
import { createConnectionsRouter } from '../connections-router.js';
vi.mock('../auth.js', () => ({ verifyPassphrase: (value: string) => value === 'correct' }));
describe('connections router', () => {
  it('denies internal-only mutations and requires recent csrf reauthorization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-router-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const service = { provision: vi.fn(), revoke: vi.fn() };
    const app = express();
    app.use((req, res, next) => {
      if (req.header('x-browser') === 'yes')
        res.locals.authSession = { id: 'session', expiresAt: Date.now() + 1_000 };
      next();
    });
    app.use(
      '/api/connections',
      createConnectionsRouter({
        store,
        service: service as never,
        eligibleAccounts: () => ['work'],
        gateway: 'openshell',
        workspace: 'default',
        legacyProviders: async () => [],
      }),
    );
    const internal = await request(app)
      .post('/api/connections')
      .set('x-internal-token', 'token')
      .send({});
    expect(internal.status).toBe(401);
    const reauth = await request(app)
      .post('/api/connections/reauthorize')
      .set('x-browser', 'yes')
      .send({ passphrase: 'correct' });
    expect(reauth.headers['cache-control']).toBe('no-store');
    const rejected = await request(app)
      .post('/api/connections')
      .set('x-browser', 'yes')
      .send({ label: 'Jira', email: 'a@example.com', token: 'secret', accountIds: ['work'] });
    expect(rejected.status).toBe(403);
    expect(JSON.stringify(rejected.body)).not.toContain('secret');
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('enforces trusted JSON browser mutations and projects only safe owned connection fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-router-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const connection = store.create({
      ownerId: 'operator',
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: 'Work Jira',
      endpoint: 'https://redhat.atlassian.net',
      gatewayProviderName: 'mitzo-conn-12345678',
      desiredAccountIds: ['work'],
      submittedEmail: 'person@example.com',
    });
    const service = {
      createAndProvision: vi.fn(),
      retry: vi.fn(),
      test: vi.fn().mockResolvedValue(connection),
      rotate: vi.fn().mockResolvedValue(connection),
      setAssignments: vi.fn((_id, revision) => {
        if (revision !== connection.revision) throw new RevisionConflictError();
        return connection;
      }),
      revoke: vi.fn().mockResolvedValue(connection),
    };
    const app = express();
    app.use((req, res, next) => {
      if (req.header('x-browser') === 'yes')
        res.locals.authSession = {
          id: req.header('x-session') ?? 'session-two',
          expiresAt: req.header('x-expired') === 'yes' ? Date.now() - 1 : Date.now() + 60_000,
        };
      next();
    });
    app.use(
      '/api/connections',
      createConnectionsRouter({
        store,
        service: service as never,
        eligibleAccounts: () => ['work'],
        gateway: 'openshell',
        workspace: 'default',
        legacyProviders: async () => [],
      }),
    );

    expect((await request(app).get('/api/connections')).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/connections/reauthorize')
          .set('x-browser', 'yes')
          .set('Origin', 'https://evil.example')
          .send({ passphrase: 'correct' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/connections/${connection.id}/test`)
          .set('x-browser', 'yes')
          .set('Content-Type', 'text/plain')
          .send('not-json')
      ).status,
    ).toBe(415);
    const malformed = await request(app)
      .post('/api/connections/reauthorize')
      .set('x-browser', 'yes')
      .set('Content-Type', 'application/json')
      .send('{"passphrase":"SENTINEL_MALFORMED"');
    expect(malformed.status).toBe(400);
    expect(malformed.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(malformed.body)).toEqual('{"error":"Invalid JSON"}');
    expect(JSON.stringify(malformed.body)).not.toContain('SENTINEL_MALFORMED');

    const authorization = await request(app)
      .post('/api/connections/reauthorize')
      .set('x-browser', 'yes')
      .send({ passphrase: 'correct' });
    const csrf = authorization.body.csrf;
    const failedCreate = await request(app)
      .post('/api/connections')
      .set('x-browser', 'yes')
      .set('x-csrf-token', csrf)
      .send({
        label: 'Jira',
        email: 'person@example.com',
        token: 'SENTINEL_DO_NOT_LEAK',
        accountIds: ['work'],
      });
    expect(failedCreate.status).toBe(422);
    expect(JSON.stringify(failedCreate.body)).not.toContain('SENTINEL_DO_NOT_LEAK');
    const tested = await request(app)
      .post(`/api/connections/${connection.id}/test`)
      .set('x-browser', 'yes')
      .send({ csrf, revision: connection.revision });
    expect(tested.status).toBe(200);
    expect(tested.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(tested.body)).not.toContain('gatewayProviderName');
    expect(JSON.stringify(tested.body)).not.toContain('submittedEmail');
    expect(service.test).toHaveBeenCalledWith(
      connection.id,
      connection.revision,
      expect.anything(),
    );
    const rotated = await request(app)
      .post(`/api/connections/${connection.id}/rotate`)
      .set('x-browser', 'yes')
      .send({ csrf, revision: connection.revision, token: 'SENTINEL_ROTATE' });
    expect(rotated.status).toBe(200);
    expect(JSON.stringify(rotated.body)).not.toContain('SENTINEL_ROTATE');
    expect(service.rotate).toHaveBeenCalledWith(
      connection.id,
      connection.revision,
      'SENTINEL_ROTATE',
      expect.anything(),
    );

    const stale = await request(app)
      .put(`/api/connections/${connection.id}/assignments`)
      .set('x-browser', 'yes')
      .send({ csrf, revision: connection.revision + 1, accountIds: ['work'] });
    expect(stale.status).toBe(409);
    const retryable = store.transition(
      connection.id,
      connection.revision,
      { status: 'needs_attention', errorCode: 'PROVISION_FAILED' },
      { operation: 'provision', outcome: 'failed', actor: 'operator' },
    );
    service.retry.mockResolvedValue(retryable);
    const retried = await request(app)
      .post(`/api/connections/${connection.id}/retry`)
      .set('x-browser', 'yes')
      .send({ csrf, revision: retryable.revision, token: 'SENTINEL_RETRY' });
    expect(retried.status).toBe(200);
    expect(JSON.stringify(retried.body)).not.toContain('SENTINEL_RETRY');
    expect(service.retry).toHaveBeenCalledWith(
      connection.id,
      retryable.revision,
      'SENTINEL_RETRY',
      expect.anything(),
    );
    const oversized = await request(app)
      .post('/api/connections/reauthorize')
      .set('x-browser', 'yes')
      .send({ passphrase: 'x'.repeat(3_000) });
    expect(oversized.status).toBe(413);
    const expired = await request(app)
      .post('/api/connections/reauthorize')
      .set('x-browser', 'yes')
      .set('x-expired', 'yes')
      .send({ passphrase: 'correct' });
    expect(expired.status).toBe(401);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { ConnectionStore, RevisionConflictError } from '../connections-store.js';
import { ConnectionsService } from '../connections-service.js';
import { createConnectionsRouter } from '../connections-router.js';

vi.mock('../auth.js', () => ({
  verifyPassphrase: (value: string) => value === 'correct',
  isAuthSessionCurrent: () => true,
}));
const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'github-repository-scope-'));
  const store = new ConnectionStore(join(root, 'connections.db'));
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const created = store.create({
    ownerId: 'operator',
    templateId: 'github-readonly',
    templateVersion: 1,
    label: 'GitHub',
    endpoint: 'https://api.github.com',
    publicConfig: { allowedRepositories: ['dimakis/mgmt'], allowedBaseBranches: ['main'] },
    gatewayProviderName: 'mitzo-conn-retained',
    desiredAccountIds: ['personal', 'work'],
  });
  const connection = store.transition(
    created.id,
    created.revision,
    {
      status: 'active',
      gatewayProviderId: 'original-provider',
      identity: 'dimakis',
      verifiedAt: 10,
    },
    { actor: 'operator', operation: 'provision', outcome: 'success' },
  );
  const gateway = {
    get: vi.fn(async () => ({
      id: 'original-provider',
      name: connection.gatewayProviderName,
      type: 'github',
      workspace: 'default',
      credentialKeys: ['GITHUB_TOKEN'],
    })),
    validateBinding: vi.fn(),
    rotate: vi.fn(),
    provision: vi.fn(),
    stopSandbox: vi.fn(),
  };
  const service = new ConnectionsService(store, gateway as never);
  return { store, connection, gateway, service };
}

describe('GitHub repository scope', () => {
  it('adds a repository to the original verified connection without changing credentials, account assignments or the provider', async () => {
    const { store, connection, gateway, service } = fixture();
    const updated = await service.addGithubRepository(
      connection.id,
      connection.revision,
      'Dimakis/Mitzo',
      'operator',
      AbortSignal.timeout(1000),
    );
    expect(updated).toEqual({
      ...connection,
      publicConfig: {
        ...connection.publicConfig,
        allowedRepositories: ['dimakis/mgmt', 'dimakis/mitzo'],
      },
      revision: connection.revision + 1,
      updatedAt: expect.any(Number),
    });
    expect(store.audit(connection.id).at(-1)).toMatchObject({
      operation: 'github_repository',
      outcome: 'added',
      actor: 'operator',
      affectedRefs: ['dimakis/mitzo'],
    });
    expect(gateway.get).toHaveBeenCalledOnce();
    expect(gateway.rotate).not.toHaveBeenCalled();
    expect(gateway.provision).not.toHaveBeenCalled();
    expect(gateway.stopSandbox).not.toHaveBeenCalled();
    await expect(
      service.addGithubRepository(
        connection.id,
        connection.revision,
        'dimakis/another',
        'operator',
        AbortSignal.timeout(1000),
      ),
    ).rejects.toBeInstanceOf(RevisionConflictError);
    const again = await service.addGithubRepository(
      updated.id,
      updated.revision,
      'dimakis/mitzo',
      'operator',
      AbortSignal.timeout(1000),
    );
    expect(again).toEqual(updated);
    expect(store.audit(connection.id)).toHaveLength(3);
  });

  it('refuses foreign owners, invalid repositories, nonactive connections and a changed physical provider', async () => {
    const { store, connection, gateway, service } = fixture();
    for (const [repository, actor] of [
      ['dimakis/mitzo', 'other'],
      ['https://evil.test/repo', 'operator'],
      ['dimakis/../mitzo', 'operator'],
    ]) {
      await expect(
        service.addGithubRepository(
          connection.id,
          connection.revision,
          repository,
          actor,
          AbortSignal.timeout(1000),
        ),
      ).rejects.toThrow();
    }
    expect(store.get(connection.id)).toEqual(connection);
    gateway.get.mockResolvedValue({
      id: 'replacement',
      name: connection.gatewayProviderName,
      type: 'github',
      workspace: 'default',
      credentialKeys: ['GITHUB_TOKEN'],
    });
    await expect(
      service.addGithubRepository(
        connection.id,
        connection.revision,
        'dimakis/mitzo',
        'operator',
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow();
    const inactive = store.transition(
      connection.id,
      connection.revision,
      { status: 'needs_attention' },
      { actor: 'operator', operation: 'test', outcome: 'failed' },
    );
    await expect(
      service.addGithubRepository(
        inactive.id,
        inactive.revision,
        'dimakis/mitzo',
        'operator',
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow();
    expect(store.get(connection.id)?.publicConfig).toEqual(connection.publicConfig);
  });

  it('rechecks cancellation and the original revision after asynchronous provider verification', async () => {
    const { store, connection, gateway, service } = fixture();
    const abort = new AbortController();
    gateway.get.mockImplementationOnce(async () => {
      abort.abort();
      return {
        id: 'original-provider',
        name: connection.gatewayProviderName,
        type: 'github',
        workspace: 'default',
        credentialKeys: ['GITHUB_TOKEN'],
      };
    });
    await expect(
      service.addGithubRepository(
        connection.id,
        connection.revision,
        'dimakis/mitzo',
        'operator',
        abort.signal,
      ),
    ).rejects.toThrow();
    expect(store.get(connection.id)).toEqual(connection);
    gateway.get.mockImplementationOnce(async () => {
      store.transition(
        connection.id,
        connection.revision,
        { errorCode: 'changed' },
        { actor: 'operator', operation: 'test', outcome: 'changed' },
      );
      return {
        id: 'original-provider',
        name: connection.gatewayProviderName,
        type: 'github',
        workspace: 'default',
        credentialKeys: ['GITHUB_TOKEN'],
      };
    });
    await expect(
      service.addGithubRepository(
        connection.id,
        connection.revision,
        'dimakis/mitzo',
        'operator',
        AbortSignal.timeout(1000),
      ),
    ).rejects.toBeInstanceOf(RevisionConflictError);
    expect(store.get(connection.id)?.publicConfig).toEqual(connection.publicConfig);
  });

  it('refuses authority revoked while the provider check is pending', async () => {
    const { store, connection, gateway, service } = fixture();
    let authorized = true;
    gateway.get.mockImplementationOnce(async () => {
      authorized = false;
      return {
        id: 'original-provider',
        name: connection.gatewayProviderName,
        type: 'github',
        workspace: 'default',
        credentialKeys: ['GITHUB_TOKEN'],
      };
    });
    await expect(
      service.addGithubRepository(
        connection.id,
        connection.revision,
        'dimakis/mitzo',
        'operator',
        AbortSignal.timeout(1000),
        () => {
          if (!authorized) throw new Error('Operator logged out');
        },
      ),
    ).rejects.toThrow('Operator logged out');
    expect(store.get(connection.id)).toEqual(connection);
  });

  it('refuses scope removal or multiple additions in the atomic store operation', () => {
    const { store, connection } = fixture();
    expect(() =>
      store.extendGithubRepositories(
        connection.id,
        connection.revision,
        ['dimakis/mitzo'],
        'operator',
      ),
    ).toThrow();
    expect(() =>
      store.extendGithubRepositories(
        connection.id,
        connection.revision,
        ['dimakis/mgmt', 'dimakis/mitzo', 'dimakis/third'],
        'operator',
      ),
    ).toThrow();
    expect(() =>
      store.extendGithubRepositories(
        connection.id,
        connection.revision,
        ['dimakis/mgmt', 'dimakis/mitzo'],
        'other',
      ),
    ).toThrow();
    expect(store.get(connection.id)).toEqual(connection);
  });

  it('requires a fresh interactive authorization and a strict repository-only request', async () => {
    const { store, connection, service } = fixture();
    const app = express();
    app.use((req, res, next) => {
      if (req.header('x-browser') === 'yes')
        res.locals.authSession = { id: 'scope-session', expiresAt: Date.now() + 60000 };
      next();
    });
    app.use(
      '/api/connections',
      createConnectionsRouter({
        store,
        service,
        eligibleAccounts: () => ['personal', 'work'],
        gateway: 'openshell',
        workspace: 'default',
        legacyProviders: async () => [],
      }),
    );
    const path = `/api/connections/${connection.id}/github-repositories`;
    const body = {
      revision: connection.revision,
      repository: 'dimakis/mitzo',
      csrf: 'x'.repeat(32),
    };
    expect((await request(app).post(path).send(body)).status).toBe(401);
    expect((await request(app).post(path).set('x-browser', 'yes').send(body)).status).toBe(403);
    const reauth = await request(app)
      .post('/api/connections/reauthorize')
      .set('x-browser', 'yes')
      .send({ passphrase: 'correct' });
    expect(reauth.status).toBe(200);
    const authorized = { ...body, csrf: reauth.body.csrf };
    expect(
      (
        await request(app)
          .post(path)
          .set('x-browser', 'yes')
          .set('Origin', 'https://evil.test')
          .send(authorized)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(path)
          .set('x-browser', 'yes')
          .send({ ...authorized, credentials: { token: 'never-accepted' } })
      ).status,
    ).toBe(400);
    const response = await request(app).post(path).set('x-browser', 'yes').send(authorized);
    expect(response.status).toBe(200);
    expect(response.body.connection.publicConfig.allowedRepositories).toEqual([
      'dimakis/mgmt',
      'dimakis/mitzo',
    ]);
    expect(JSON.stringify(response.body)).not.toContain('gatewayProvider');
    expect(
      (
        await request(app)
          .post(path)
          .set('x-browser', 'yes')
          .send({ ...authorized, repository: 'dimakis/another' })
      ).status,
    ).toBe(409);
  });
});

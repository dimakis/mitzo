import { afterAll, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const controller = vi.hoisted(() => ({ request: vi.fn(), invalidate: vi.fn() }));
vi.mock('../symposium-custodian-mode.js', () => ({
  custodianControllerMode: true,
  custodianOwnerMode: false,
  custodianControllerClient: controller,
  receiveCustodianEvents: vi.fn(),
}));
// Emulate only configuration eligibility on Linux CI; no Keychain helper is executed.
vi.mock('../credential-connections-runtime.js', async (original) => {
  const actual = await original<typeof import('../credential-connections-runtime.js')>();
  return {
    ...actual,
    keychainConnectionConfig: (env: NodeJS.ProcessEnv) =>
      actual.keychainConnectionConfig(env, 'darwin'),
  };
});
vi.mock('../keychain-vault.js', async (original) => {
  const actual = await original<typeof import('../keychain-vault.js')>();
  return {
    ...actual,
    MacKeychainVault: class {
      save = vi.fn(async () => ({ service: 'fixture', account: 'fixture' }));
      read = vi.fn(async () => 'synthetic-secret');
      link = vi.fn();
      remove = vi.fn();
    },
  };
});
vi.mock('../credential-http.js', () => ({
  sendConnectionRequest: vi.fn(async () => ({
    status: 200,
    body: '{"entity_id":"sensor.office","state":"21","last_changed":"2026-10-17T00:00:00Z"}',
  })),
}));
const directory = mkdtempSync(join(realpathSync(tmpdir()), 'api-tool-bootstrap-'));
vi.stubEnv('REPO_PATH', directory);
vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '');
const engine = await import('../app.js');
const runtimeModule = await import('../credential-connections-runtime.js');
afterAll(() => {
  engine.setCredentialConnectionsRuntime(null);
  engine.taskStore.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
it('boots the existing connection runtime from owner settings and verifies with fake vault/HTTP', async () => {
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '1');
  vi.stubEnv('MITZO_KEYCHAIN_HELPER', '/synthetic/signed-helper');
  vi.stubEnv('MITZO_KEYCHAIN_TEAM_ID', 'ABCDEF1234');
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_DIR', join(directory, 'credentials'));
  // Test the startup initializer used by both index and the retained owner.
  const runtime = engine.configureCredentialConnectionsRuntime();
  expect(runtime?.service).toBe(runtimeModule.getCredentialConnectionsRuntime());
  expect(runtime).toBeTruthy();
  if (!runtime) throw Error('Missing owner runtime');
  try {
    const connection = await runtime.service.create(
      {
        label: 'Fixture',
        serviceTemplate: 'home-assistant',
        endpoint: 'https://ha.example.com',
        auth: { kind: 'bearer' },
        methods: ['GET'],
        paths: ['/api/'],
      },
      { secret: 'fixture' },
    );
    const { ApiToolCatalog } = await import('../api-tool-catalog.js');
    const catalog = new ApiToolCatalog(':memory:');
    try {
      const draft = catalog.save(
        {
          id: randomUUID(),
          expectedVersion: 0,
          configuration: {
            template: 'home-assistant.state@1',
            label: 'Office',
            connectionId: connection.id,
            entityId: 'sensor.office',
          },
        },
        runtime.service,
      );
      await catalog.verify(draft.id, draft.version, {
        service: runtime.service,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      expect(catalog.publish(draft.id, draft.version, runtime.service).id).toBe(`api:${draft.id}`);
      expect(runtime.service.sessions(connection.id)).toEqual([]);
    } finally {
      catalog.close();
    }
  } finally {
    engine.setCredentialConnectionsRuntime(null);
    runtime.store.close();
    vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '');
  }
});
it('leaves connection authority unavailable when disabled or misconfigured', () => {
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '');
  expect(engine.configureCredentialConnectionsRuntime()).toBeNull();
  expect(runtimeModule.getCredentialConnectionsRuntime()).toBeNull();
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '1');
  vi.stubEnv('MITZO_KEYCHAIN_HELPER', 'relative');
  expect(engine.configureCredentialConnectionsRuntime()).toBeNull();
  expect(runtimeModule.getCredentialConnectionsRuntime()).toBeNull();
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '');
});
it('reauthorizes in a credential-free controller and forwards only verified recent authority', async () => {
  engine.setCredentialConnectionsRuntime(null);
  expect(runtimeModule.getCredentialConnectionsRuntime()).toBeNull();
  const agent = request.agent(engine.app);
  await agent
    .post('/api/auth/login')
    .send({ passphrase: 'test-passphrase-for-vitest' })
    .expect(200);
  const base = '/api/agent-library/api-tools';
  const body = { id: randomUUID(), version: 1 };
  controller.request.mockResolvedValue({ status: 200, body: { verified: true } });
  await agent
    .post(base + '/verify')
    .send(body)
    .expect(403);
  expect(controller.request).not.toHaveBeenCalled();
  await request(engine.app)
    .post('/api/credential-connections/reauthorize')
    .send({ passphrase: 'test-passphrase-for-vitest' })
    .expect(403);
  await agent
    .post('/api/credential-connections/reauthorize')
    .set('Origin', 'https://evil.example')
    .send({ passphrase: 'test-passphrase-for-vitest' })
    .expect(403);
  await agent
    .post('/api/credential-connections/reauthorize')
    .send({ passphrase: 'wrong' })
    .expect(403);
  const authorized = await agent
    .post('/api/credential-connections/reauthorize')
    .send({ passphrase: 'test-passphrase-for-vitest' })
    .expect(200);
  await agent
    .post(base + '/verify')
    .set('x-csrf-token', authorized.body.csrf)
    .send(body)
    .expect(200);
  expect(controller.request).toHaveBeenCalledOnce();
  expect(controller.request.mock.calls[0][0]).toMatchObject({
    operation: 'library.apiVerify',
    body,
    authorization: { recentUntil: authorized.body.expiresAt },
  });
  expect(JSON.stringify(controller.request.mock.calls[0][0])).not.toContain('passphrase');
  expect(runtimeModule.getCredentialConnectionsRuntime()).toBeNull();
});

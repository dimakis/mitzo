import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CredentialConnections, CredentialConnectionStore } from '../credential-connections.js';
import { attachSecretRelay } from '../secret-relay-runtime.js';
import type { StoredSecretRelay } from '../secret-relay.js';

const vault = {
  save: vi.fn(async () => ({ service: 'fixture', account: 'token' })),
  read: vi.fn(async () => 'connection-token'),
  remove: vi.fn(async () => {}),
  link: vi.fn(async () => ({ service: 'fixture', account: 'token' })),
};
const leakedBody = JSON.stringify({
  password: 'relay-password',
  cookie: 'private-cookie',
  otp: '123456',
});

it.each(['cancelled', 'expired'] as const)(
  'retains relay response protections across restart with execution disabled and %s receipts',
  async (status) => {
    const directory = mkdtempSync(join(tmpdir(), 'mitzo-retained-relay-'));
    let store = new CredentialConnectionStore(join(directory, 'connections.db'));
    const send = vi.fn(async () => ({ status: 200, body: leakedBody }));
    const dashboard = vi.fn(async () => leakedBody);
    const websocket = vi.fn(async () => leakedBody);
    try {
      const first = new CredentialConnections(store, vault, send, dashboard, websocket);
      const connectionInput = {
        label: 'Service',
        endpoint: 'https://service.example',
        auth: { kind: 'bearer' },
        paths: ['/api/'],
        methods: ['GET'],
        serviceTemplate: 'home-assistant',
        homeAssistantDashboards: 'read',
        websocket: { path: '/api/socket', authentication: { kind: 'headers' } },
      };
      const connections = await Promise.all([
        first.create(connectionInput, { secret: 'fixture' }),
        first.create(
          { ...connectionInput, endpoint: 'https://unrelated.example' },
          { secret: 'fixture' },
        ),
      ]);
      const record: StoredSecretRelay = {
        id: 'retained',
        sessionId: 'previous-chat',
        revision: 3,
        label: 'Private value',
        expiresAt: 1,
        status,
        setupUrl: '/connections/secrets/retained',
        vaultRef: {
          gateway: 'fixture',
          workspace: 'fixture',
          providerId: 'fixture',
          name: 'mitzo-secret-00000000-0000-0000-0000-000000000000',
          version: '1',
          profileVersion: '1',
        },
        targets: [
          {
            connectionId: 'previous-connection',
            revision: 1,
            endpoint: connectionInput.endpoint,
            label: 'Service',
            path: '/api/password',
            method: 'POST',
            encoding: 'json',
            body: '{}',
            fields: ['/password'],
          },
        ],
        outcomes: [{ outcome: 'confirmed' }],
      };
      store.putRelay(record);
      for (const connection of connections)
        first.grant('new-chat', connection.id, connection.revision);
      store.close();
      store = new CredentialConnectionStore(join(directory, 'connections.db'));
      const restarted = new CredentialConnections(store, vault, send, dashboard, websocket);
      attachSecretRelay(restarted, store, { MITZO_SECRET_RELAY_ENABLED: '0' });
      expect(restarted.relay).toBeUndefined();
      const read = (id: string) => [
        () =>
          restarted.request(
            'new-chat',
            id,
            { path: '/api/', method: 'GET' },
            AbortSignal.timeout(1000),
          ),
        () =>
          restarted.websocketRequest('new-chat', id, { message: '{}' }, AbortSignal.timeout(1000)),
        () =>
          restarted.dashboardRequest(
            'new-chat',
            id,
            { operation: 'read' },
            AbortSignal.timeout(1000),
          ),
      ];
      for (const request of read(connections[0].id)) await expect(request()).rejects.toThrow();
      // Browser receipts also protect cookies/codes when the password cannot be retrieved.
      store.putRelay({
        ...record,
        vaultRef: undefined,
        targets: [
          {
            adapter: 'browser',
            origin: connectionInput.endpoint,
            endpoint: connectionInput.endpoint,
            label: 'Service',
            allowPrivateNetwork: false,
            requests: [{ path: '/login', methods: ['GET', 'POST'] }],
            login: { path: '/login', passwordSelector: '#password', submitSelector: '#login' },
            verification: { path: '/whoami', pointer: '/authenticated', equals: true },
            actions: [],
          },
        ],
      });
      for (const request of read(connections[0].id)) await expect(request()).rejects.toThrow();
      for (const request of read(connections[1].id))
        expect(JSON.stringify(await request())).toContain('private-cookie');
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

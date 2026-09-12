import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectionStore } from '../connections-store.js';
import { ConnectionsService } from '../connections-service.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'connections-regression-'));
  const store = new ConnectionStore(join(dir, 'connections.db'));
  const connection = store.create({
    ownerId: 'operator',
    templateId: 'jira-readonly',
    templateVersion: 1,
    label: 'Jira',
    endpoint: 'https://redhat.atlassian.net',
    gatewayProviderName: 'mitzo-conn-12345678',
    desiredAccountIds: ['work'],
  });
  const gateway = {
    verifyCompatibility: vi.fn(),
    provision: vi
      .fn()
      .mockResolvedValue({
        id: 'provider-1',
        name: connection.gatewayProviderName,
        workspace: 'default',
        type: 'jira-readonly',
        credentialKeys: ['JIRA_API_TOKEN'],
      }),
    rotate: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    attachments: vi.fn().mockResolvedValue([]),
    stopSandbox: vi.fn(),
    sandboxStopped: vi.fn().mockResolvedValue(true),
    detach: vi.fn(),
    probe: vi.fn().mockResolvedValue({ identity: 'account-1' }),
    deleteSandbox: vi.fn().mockRejectedValue(new Error('cleanup failed')),
  };
  return {
    dir,
    store,
    connection,
    gateway,
    service: new ConnectionsService(store, gateway as never),
  };
}

describe('Connections lifecycle regressions', () => {
  it('does not activate a connection when probe cleanup is pending', async () => {
    const x = setup();
    await expect(
      x.service.provision(x.connection, 'token', new AbortController().signal),
    ).rejects.toThrow();
    expect(x.store.get(x.connection.id)?.status).not.toBe('active');
    expect(x.store.pendingProbes()).toHaveLength(1);
    x.store.close();
    rmSync(x.dir, { recursive: true, force: true });
  });
  it('fresh account resolution disappears after revoke intent removes assignments', async () => {
    const x = setup();
    const active = x.store.transition(
      x.connection.id,
      1,
      { status: 'active', verifiedAt: Date.now(), gatewayProviderId: 'provider-1' },
      { operation: 'activate', outcome: 'success', actor: 'operator' },
    );
    expect(x.service.resolveForAccount('work')).not.toBeNull();
    x.gateway.delete.mockResolvedValue(undefined);
    await x.service.revoke(active.id, active.revision, 'operator', new AbortController().signal);
    expect(x.service.resolveForAccount('work')).toBeNull();
    x.store.close();
    rmSync(x.dir, { recursive: true, force: true });
  });
});

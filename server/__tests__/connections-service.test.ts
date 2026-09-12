import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectionStore } from '../connections-store.js';
import { ConnectionsService } from '../connections-service.js';
describe('ConnectionsService', () => {
  it('does not mark failed provisioning active and retries revoke after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const item = store.create({
      ownerId: 'operator',
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: 'Jira',
      endpoint: 'https://redhat.atlassian.net',
      gatewayProviderName: 'mitzo-conn-12345678',
      desiredAccountIds: [],
    });
    const gateway = {
      verifyCompatibility: vi.fn(),
      provision: vi.fn().mockRejectedValue(new Error('untrusted CLI output')),
      rotate: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      sandbox: vi.fn(),
      sandboxProviders: vi.fn(),
      delete: vi.fn().mockRejectedValue(new Error('attached')),
      attachments: vi.fn().mockResolvedValue([]),
      stopSandbox: vi.fn(),
      sandboxStopped: vi.fn().mockResolvedValue(true),
      detach: vi.fn(),
      probe: vi.fn(),
      deleteSandbox: vi.fn(),
    };
    const service = new ConnectionsService(store, gateway);
    await expect(service.provision(item, 'SENTINEL', new AbortController().signal)).rejects.toThrow(
      'provisioning failed',
    );
    expect(store.get(item.id)?.status).toBe('needs_attention');
    const failed = store.get(item.id)!;
    gateway.get.mockResolvedValue({
      id: 'provider-1',
      name: item.gatewayProviderName,
      workspace: 'default',
      type: 'jira-readonly',
      credentialKeys: ['JIRA_API_TOKEN'],
    });
    gateway.delete.mockResolvedValue(undefined);
    await service.revoke(item.id, failed.revision, 'operator', new AbortController().signal);
    expect(store.get(item.id)?.status).toBe('revoked');
    expect(gateway.attachments).toHaveBeenCalledTimes(2);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

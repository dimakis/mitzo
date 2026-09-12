import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectionStore } from '../connections-store.js';
import { ConnectionsService } from '../connections-service.js';
import { ConnectionProbeError, OpenShellConnectionGateway } from '../connections-gateway.js';
describe('ConnectionsService', () => {
  it('retains a typed probe error after rotation candidate cleanup', async () => {
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
      submittedEmail: 'person@example.test',
    });
    const active = store.transition(
      item.id,
      item.revision,
      { status: 'active', gatewayProviderId: 'p1', identity: 'account', verifiedAt: Date.now() },
      { operation: 'provision', outcome: 'success', actor: 'operator' },
    );
    const original = {
      id: 'p1',
      name: active.gatewayProviderName,
      workspace: 'default',
      type: 'jira-readonly',
      credentialKeys: ['JIRA_API_TOKEN'],
    };
    const gateway = {
      verifyCompatibility: vi.fn(),
      provision: vi.fn(async ({ name }: { name: string }) => ({
        ...original,
        id: 'candidate',
        name,
      })),
      rotate: vi.fn(),
      get: vi.fn(async (name: string) =>
        name === active.gatewayProviderName ? original : undefined,
      ),
      list: vi.fn(),
      delete: vi.fn(),
      attachments: vi.fn().mockResolvedValue([]),
      stopSandbox: vi.fn(),
      sandboxStopped: vi.fn().mockResolvedValue(true),
      detach: vi.fn(),
      probe: vi.fn().mockRejectedValue(new ConnectionProbeError('JIRA_PERMISSION_DENIED')),
      deleteSandbox: vi.fn().mockResolvedValue(undefined),
      sandbox: vi.fn(),
      sandboxProviders: vi.fn(),
    };
    await expect(
      new ConnectionsService(store, gateway as never).rotate(
        active.id,
        active.revision,
        'token',
        AbortSignal.timeout(500),
      ),
    ).rejects.toThrow('rotation failed');
    expect(store.get(active.id)).toMatchObject({ errorCode: 'JIRA_PERMISSION_DENIED' });
    expect(store.candidates()).toEqual([]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('quarantines a typed probe failure, cleans it up, then records only its safe code', async () => {
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
      submittedEmail: 'person@example.test',
    });
    const active = store.transition(
      item.id,
      item.revision,
      { status: 'active', gatewayProviderId: 'p1', identity: 'a', verifiedAt: Date.now() },
      { operation: 'provision', outcome: 'success', actor: 'operator' },
    );
    const gateway = {
      verifyCompatibility: vi.fn(),
      provision: vi.fn(),
      rotate: vi.fn(),
      get: vi.fn().mockResolvedValue({
        id: 'p1',
        name: active.gatewayProviderName,
        workspace: 'default',
        type: 'jira-readonly',
        credentialKeys: ['JIRA_API_TOKEN'],
      }),
      list: vi.fn(),
      delete: vi.fn(),
      attachments: vi.fn().mockResolvedValue([]),
      stopSandbox: vi.fn(),
      sandboxStopped: vi.fn().mockResolvedValue(true),
      detach: vi.fn(),
      probe: vi.fn().mockRejectedValue(new ConnectionProbeError('JIRA_AUTH_REJECTED')),
      deleteSandbox: vi.fn().mockResolvedValue(undefined),
      sandbox: vi.fn(),
      sandboxProviders: vi.fn(),
    };
    await expect(
      new ConnectionsService(store, gateway as never).test(
        active.id,
        active.revision,
        AbortSignal.timeout(500),
      ),
    ).rejects.toThrow('verification failed');
    expect(gateway.deleteSandbox).toHaveBeenCalled();
    expect(store.get(active.id)).toMatchObject({ errorCode: 'JIRA_AUTH_REJECTED' });
    expect(store.pendingQuarantines()).toEqual([]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('finishes durable probe cleanup when the gateway authoritatively reports an absent sandbox', async () => {
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
    store.startProbe(item, 'mitzo-probe-1234567890abcdef');
    const gateway = new OpenShellConnectionGateway(vi.fn().mockResolvedValue('[]'));
    await new ConnectionsService(store, gateway).reconcile(AbortSignal.timeout(500));
    expect(store.pendingProbes()).toEqual([]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('keeps cleanup pending when probe existence cannot be authoritatively read', async () => {
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
    store.startProbe(item, 'mitzo-probe-1234567890abcdef');
    const gateway = new OpenShellConnectionGateway(vi.fn().mockResolvedValue('not-json'));
    await new ConnectionsService(store, gateway).reconcile(AbortSignal.timeout(500));
    expect(store.pendingProbes()).toMatchObject([{ status: 'cleanup_pending' }]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('allows a retry after a failed provision when disposable probe cleanup sees absence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const adapter = new OpenShellConnectionGateway(vi.fn().mockResolvedValue('[]'));
    const gateway = {
      verifyCompatibility: vi.fn(),
      provision: vi.fn().mockResolvedValue({
        id: 'provider-1',
        name: 'mitzo-conn-12345678',
        workspace: 'default',
        type: 'jira-readonly',
        credentialKeys: ['JIRA_API_TOKEN'],
      }),
      rotate: vi.fn(),
      get: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({
          id: 'provider-1',
          name: 'mitzo-conn-12345678',
          workspace: 'default',
          type: 'jira-readonly',
          credentialKeys: ['JIRA_API_TOKEN'],
        }),
      list: vi.fn(),
      delete: vi.fn(),
      attachments: vi.fn(),
      stopSandbox: vi.fn(),
      sandboxStopped: vi.fn(),
      detach: vi.fn(),
      probe: vi
        .fn()
        .mockRejectedValueOnce(new Error('probe failed'))
        .mockResolvedValue({ identity: 'operator@example.test' }),
      deleteSandbox: adapter.deleteSandbox.bind(adapter),
      sandbox: vi.fn(),
      sandboxProviders: vi.fn(),
    };
    const service = new ConnectionsService(store, gateway);
    const input = {
      ownerId: 'operator',
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: 'Jira',
      endpoint: 'https://redhat.atlassian.net',
      gatewayProviderName: 'mitzo-conn-12345678',
      desiredAccountIds: [],
      submittedEmail: 'operator@example.test',
    };
    await expect(
      service.createAndProvision(input, 'first-token', AbortSignal.timeout(500)),
    ).rejects.toThrow('provisioning failed');
    const failed = store.list('operator')[0]!;
    await expect(
      service.retry(failed.id, failed.revision, 'second-token', AbortSignal.timeout(500)),
    ).resolves.toMatchObject({ status: 'active', identity: 'operator@example.test' });
    expect(gateway.rotate).toHaveBeenCalledWith(
      { name: failed.gatewayProviderName, token: 'second-token' },
      expect.anything(),
    );
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
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

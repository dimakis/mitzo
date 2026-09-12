import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../connections-store.js';
import { ConnectionsService } from '../connections-service.js';
import type { ConnectionGateway, GatewayProvider } from '../connections-gateway.js';
const stores: ConnectionStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function setup() {
  const store = new ConnectionStore(':memory:');
  stores.push(store);
  const providers = new Map<string, GatewayProvider>();
  const attachments = new Map<string, string[]>();
  const gateway: ConnectionGateway = {
    verifyCompatibility: vi.fn(),
    provision: vi.fn(async ({ name }) => {
      const p = {
        id: `id-${name}`,
        name,
        workspace: 'default',
        type: 'jira-readonly',
        credentialKeys: ['JIRA_API_TOKEN'],
      };
      providers.set(name, p);
      return p;
    }),
    get: vi.fn(async (name) => providers.get(name)),
    list: vi.fn(async () => [...providers.values()]),
    rotate: vi.fn(),
    delete: vi.fn(async (name) => {
      providers.delete(name);
    }),
    attachments: vi.fn(async (name) => attachments.get(name) ?? []),
    stopSandbox: vi.fn(),
    sandboxStopped: vi.fn(async () => true),
    detach: vi.fn(async (sandbox, name) => {
      attachments.set(
        name,
        (attachments.get(name) ?? []).filter((x) => x !== sandbox),
      );
    }),
    sandbox: vi.fn(async (name) => ({
      name,
      phase: 'Ready',
      labels: { 'mitzo.connection_account': 'work' },
    })),
    sandboxProviders: vi.fn(async () => []),
    probe: vi.fn(async () => ({ identity: 'same-account' })),
    deleteSandbox: vi.fn(),
  };
  const service = new ConnectionsService(store, gateway, {
    eligibleAccountIds: () => ['work', 'personal'],
  });
  const created = store.create({
    ownerId: 'operator',
    templateId: 'jira-readonly',
    templateVersion: 1,
    label: 'Jira',
    endpoint: 'https://redhat.atlassian.net',
    gatewayProviderName: 'mitzo-conn-12345678',
    submittedEmail: 'user@example.test',
    desiredAccountIds: ['work'],
  });
  return { store, providers, attachments, gateway, service, created };
}
describe('durable connection recovery', () => {
  it('refuses replacing or deleting a same-name provider with a different opaque id', async () => {
    const x = setup();
    const active = await x.service.provision(x.created, 'SECRET', AbortSignal.timeout(1000));
    x.providers.set(active.gatewayProviderName, {
      ...x.providers.get(active.gatewayProviderName)!,
      id: 'different',
    });
    await expect(
      x.service.rotate(active.id, active.revision, 'NEXT', AbortSignal.timeout(1000)),
    ).rejects.toThrow('binding changed');
    expect(x.gateway.rotate).not.toHaveBeenCalled();
    await expect(
      x.service.revoke(active.id, active.revision, 'operator', AbortSignal.timeout(1000)),
    ).rejects.toThrow('pending');
    expect(x.gateway.delete).not.toHaveBeenCalled();
  });
  it('persists assignment removals until retained sandbox detachment succeeds and resumes after restart', async () => {
    const x = setup();
    const active = await x.service.provision(x.created, 'SECRET', AbortSignal.timeout(1000));
    x.attachments.set(active.gatewayProviderName, ['retained']);
    vi.mocked(x.gateway.detach).mockRejectedValueOnce(new Error('unavailable'));
    await expect(x.service.setAssignments(active.id, active.revision, [])).rejects.toThrow();
    expect(x.store.pendingAssignments()).toHaveLength(1);
    expect(x.service.resolveForAccount('work')).toBeNull();
    const restarted = new ConnectionsService(x.store, x.gateway, {
      eligibleAccountIds: () => ['work', 'personal'],
    });
    await restarted.reconcile(AbortSignal.timeout(1000));
    expect(x.store.pendingAssignments()).toHaveLength(0);
    expect(x.store.get(active.id)).toMatchObject({ status: 'active', desiredAccountIds: [] });
    expect(x.attachments.get(active.gatewayProviderName)).toEqual([]);
  });
  it('cleans a rejected identity candidate without changing the working credential', async () => {
    const x = setup();
    const active = await x.service.provision(x.created, 'SECRET', AbortSignal.timeout(1000));
    vi.mocked(x.gateway.probe).mockResolvedValueOnce({ identity: 'different-account' });
    await expect(
      x.service.rotate(active.id, active.revision, 'OTHER', AbortSignal.timeout(1000)),
    ).rejects.toThrow('rotation failed');
    expect(x.gateway.rotate).not.toHaveBeenCalled();
    expect(x.providers.size).toBe(1);
    expect(x.store.candidates()).toEqual([]);
    expect(x.store.get(active.id)?.identity).toBe('same-account');
  });
  it('routes a verified connection retry through identity-preserving rotation', async () => {
    const x = setup();
    const active = await x.service.provision(x.created, 'SECRET', AbortSignal.timeout(1000));
    const failed = x.store.transition(
      active.id,
      active.revision,
      { status: 'needs_attention', errorCode: 'ROTATION_FAILED' },
      { operation: 'rotate', outcome: 'failed', actor: 'operator' },
    );
    await expect(
      x.service.retry(failed.id, failed.revision, 'NEXT', AbortSignal.timeout(1000)),
    ).resolves.toMatchObject({ status: 'active', identity: 'same-account' });
    expect(x.gateway.rotate).toHaveBeenCalledWith(
      { name: active.gatewayProviderName, token: 'NEXT' },
      expect.anything(),
    );
  });
  it('uses an independent cleanup signal after probe timeout', async () => {
    const x = setup();
    const signal = AbortSignal.abort();
    vi.mocked(x.gateway.probe).mockRejectedValueOnce(new Error('timeout'));
    await expect(x.service.provision(x.created, 'SECRET', signal)).rejects.toThrow(
      'provisioning failed',
    );
    expect(x.gateway.deleteSandbox).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ aborted: false }),
    );
    expect(x.store.pendingProbes()).toEqual([]);
  });
});

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
    submittedEmail: 'person@example.test',
    desiredAccountIds: ['work'],
  });
  const gateway = {
    verifyCompatibility: vi.fn(),
    provision: vi.fn().mockResolvedValue({
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
  it('revokes managed access before archiving and cannot revive an archived connection', async () => {
    const x = setup();
    const active = x.store.transition(
      x.connection.id,
      1,
      { status: 'active', verifiedAt: Date.now(), gatewayProviderId: 'provider-1' },
      { operation: 'activate', outcome: 'success', actor: 'operator' },
    );
    x.gateway.get.mockResolvedValue({
      id: 'provider-1',
      name: active.gatewayProviderName,
      workspace: 'default',
      type: 'jira-readonly',
      credentialKeys: ['JIRA_API_TOKEN'],
    });
    await expect(
      x.service.archive(active.id, active.revision, 'operator', AbortSignal.timeout(500)),
    ).resolves.toMatchObject({ status: 'revoked', archivedAt: expect.any(Number) });
    expect(x.gateway.delete).toHaveBeenCalledWith(active.gatewayProviderName, expect.anything());
    await expect(
      x.service.test(active.id, active.revision + 2, AbortSignal.timeout(500)),
    ).rejects.toThrow('not found');
    x.store.close();
    rmSync(x.dir, { recursive: true, force: true });
  });
  it('refuses archive while a durable cleanup operation remains', async () => {
    const x = setup();
    const revoked = x.store.transition(
      x.connection.id,
      1,
      { status: 'revoked', desiredAccountIds: [] },
      { operation: 'revoke', outcome: 'success', actor: 'operator' },
    );
    x.store.startProbe(revoked, 'mitzo-probe-1234567890abcdef');
    await expect(
      x.service.archive(revoked.id, revoked.revision, 'operator', AbortSignal.timeout(500)),
    ).rejects.toThrow('cleanup');
    x.store.close();
    rmSync(x.dir, { recursive: true, force: true });
  });
  it('does not activate a connection when probe cleanup is pending', async () => {
    const x = setup();
    await expect(
      x.service.provision(x.connection, 'token', new AbortController().signal),
    ).rejects.toThrow();
    expect(x.store.get(x.connection.id)?.status).not.toBe('active');
    expect(x.store.pendingProbes()).toHaveLength(1);
    const probeInput = x.gateway.probe.mock.calls[0]![0] as { sandboxName: string };
    expect(probeInput.sandboxName).toMatch(/^mzp-[a-f0-9]{15}$/);
    expect(probeInput.sandboxName).toHaveLength(19);
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
  it('rejects a stale revoke revision even when revocation is already pending', async () => {
    const x = setup();
    const revoking = x.store.transition(
      x.connection.id,
      1,
      { status: 'revoking', desiredAccountIds: [] },
      { operation: 'revoke', outcome: 'started', actor: 'operator' },
    );
    await expect(
      x.service.revoke(revoking.id, 1, 'operator', new AbortController().signal),
    ).rejects.toThrow(/changed/i);
    x.store.close();
    rmSync(x.dir, { recursive: true, force: true });
  });
  it('retries persisted cleanup on restart using a fresh non-aborted signal', async () => {
    const x = setup();
    const op = x.store.startProbe(x.connection, 'mitzo-probe-1234567890abcdef');
    const aborted = new AbortController();
    aborted.abort();
    x.gateway.deleteSandbox.mockResolvedValue(undefined);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await x.service.reconcile(aborted.signal);
    expect(x.gateway.deleteSandbox).toHaveBeenCalledWith(
      op.sandboxName,
      expect.objectContaining({ aborted: false }),
    );
    expect(timeout).toHaveBeenCalledWith(90_000);
    timeout.mockRestore();
    expect(x.store.pendingProbes()).toEqual([]);
    x.store.close();
    rmSync(x.dir, { recursive: true, force: true });
  });
});

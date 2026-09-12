import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  OpenShellLifecycleStore,
  openShellLifecyclePolicy,
  type OpenShellLifecycleRecord,
} from '../openshell-lifecycle.js';
import { OpenShellLifecycleService } from '../openshell-lifecycle-service.js';

const roots: string[] = [];
const DAY = 86_400_000;
function setup(phase: OpenShellLifecycleRecord['phase'] = 'stopped') {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-lifecycle-service-'));
  roots.push(root);
  const store = new OpenShellLifecycleStore(join(root, 'lifecycle.db'));
  store.upsert({
    conversationId: 'c',
    workspace: 'default',
    gateway: 'openshell',
    gatewayEndpoint: null,
    sandboxName: 'mitzo-c',
    physicalSandboxId: 'p',
    accountProvider: 'provider',
    phase,
    generation: 1,
    lastActivityAt: 100,
    idleSince: 100,
    stoppedAt: phase === 'stopped' ? 100 : null,
    stoppedResourceVersion: phase === 'stopped' ? 'stopped-v' : null,
    checkpoint:
      phase === 'stopped'
        ? { path: '/private/checkpoint', digest: 'd', version: 1, sandboxId: 'p' }
        : null,
    identity: {
      threadId: 't',
      accountId: 'a',
      provider: 'openai',
      model: 'm',
      profileRevision: '1',
      image: 'i',
      policyDigest: 'p',
      runtimeScope: 'sandbox',
      route: { kind: 'api', provider: 'provider', model: 'm' },
    },
  });
  const sandbox = {
    id: 'p',
    resourceVersion: phase === 'stopped' ? 'stopped-v' : 'ready-v',
    phase: phase === 'stopped' ? ('Stopped' as const) : ('Ready' as const),
  };
  const adapters = {
    inspect: vi.fn(async () => sandbox),
    protect: vi.fn(async () => ({ blockers: [] })),
    checkpoint: vi.fn(async () => ({
      path: '/private/checkpoint',
      digest: 'd',
      version: 1,
      sandboxId: 'p',
    })),
    verifyCheckpoint: vi.fn(async () => true),
    stop: vi.fn(async () => {
      sandbox.phase = 'Stopped';
      sandbox.resourceVersion = 'stopped-v';
    }),
    delete: vi.fn(async () => {}),
    now: () => 100 + 7 * DAY,
    consent: () => true,
    onReconcileError: undefined as
      undefined | ((record: OpenShellLifecycleRecord, error: unknown) => void),
    onOutcome: undefined as
      undefined | ((record: OpenShellLifecycleRecord, action: 'stopped' | 'deleted') => void),
  };
  return {
    store,
    sandbox,
    adapters,
    service: new OpenShellLifecycleService(
      store,
      openShellLifecyclePolicy({ MITZO_OPENSHELL_LIFECYCLE_ENABLED: '1' }),
      adapters,
    ),
  };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('blocks an unavailable protection provider instead of treating it as no protections', async () => {
  const { service, adapters } = setup();
  adapters.protect.mockRejectedValueOnce(new Error('down'));
  await expect(service.preview('c', AbortSignal.timeout(100))).rejects.toThrow('down');
});
it('reports a reconciled record failure while continuing independent records', async () => {
  const { service, adapters } = setup('retained');
  const reported = vi.fn();
  adapters.protect.mockRejectedValueOnce(new Error('control plane down'));
  adapters.onReconcileError = reported;
  await expect(service.reconcile(AbortSignal.timeout(100))).resolves.toEqual([]);
  expect(reported).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId: 'c' }),
    expect.objectContaining({ message: 'control plane down' }),
  );
});
it('allows a manual stop without granting retention consent', async () => {
  const { service, adapters } = setup('retained');
  adapters.consent = () => false;
  const preview = await service.preview('c', AbortSignal.timeout(100));
  expect(preview.action).toBe('stop');
  await expect(service.confirm(preview.token, AbortSignal.timeout(100))).resolves.toBe('stopped');
});
it('rechecks consent before a manual deletion', async () => {
  const { service, adapters } = setup();
  const preview = await service.preview('c', AbortSignal.timeout(100));
  adapters.consent = () => false;
  await expect(service.confirm(preview.token, AbortSignal.timeout(100))).rejects.toThrow(
    'consent is required',
  );
  expect(adapters.delete).not.toHaveBeenCalled();
});
it('rejects a preview after persisted retention consent is revoked', async () => {
  const { service, adapters } = setup();
  const preview = await service.preview('c', AbortSignal.timeout(100));
  service.setRetentionConsent('c', false);
  await expect(service.confirm(preview.token, AbortSignal.timeout(100))).rejects.toThrow(
    'preview is stale',
  );
  expect(adapters.delete).not.toHaveBeenCalled();
});
it('rejects out-of-band stopped version changes before deletion', async () => {
  const { service, sandbox } = setup();
  sandbox.resourceVersion = 'changed';
  const preview = await service.preview('c', AbortSignal.timeout(100));
  expect(preview.action).toBe('none');
  expect(preview.blockers).toContain('ambiguous_ownership');
});
it('automatically checkpoints and stops only an idle retained conversation with persisted consent', async () => {
  const { service, store, sandbox, adapters } = setup('retained');
  const onOutcome = vi.fn();
  adapters.onOutcome = onOutcome;
  const previews = await service.reconcile(AbortSignal.timeout(100));
  expect(previews).toHaveLength(1);
  expect(previews[0]).toMatchObject({ action: 'stop', blockers: [] });
  expect(adapters.checkpoint).toHaveBeenCalledOnce();
  expect(adapters.stop).toHaveBeenCalledOnce();
  expect(store.get('c')).toMatchObject({
    phase: 'stopped',
    checkpoint: expect.objectContaining({ sourceResourceVersion: 'ready-v' }),
    stoppedResourceVersion: 'stopped-v',
  });
  expect(sandbox.phase).toBe('Stopped');
  expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ phase: 'stopped' }), 'stopped');
});

it('deletes a retained stopped record after restart only when its checkpoint and consent remain valid', async () => {
  const { store, adapters } = setup('stopped');
  // Simulate a server restart: the durable row, not an in-memory preview,
  // determines retention eligibility.
  store.close();
  const reopened = new OpenShellLifecycleStore(roots.at(-1)! + '/lifecycle.db');
  const restarted = new OpenShellLifecycleService(
    reopened,
    openShellLifecyclePolicy({ MITZO_OPENSHELL_LIFECYCLE_ENABLED: '1' }),
    adapters,
  );
  const previews = await restarted.reconcile(AbortSignal.timeout(100));
  expect(previews).toHaveLength(1);
  expect(adapters.delete).toHaveBeenCalledOnce();
  expect(reopened.get('c')).toMatchObject({ phase: 'deleted' });
  reopened.close();
});

it('serializes concurrent confirmation and rejects the stale second action', async () => {
  const { service, adapters } = setup('stopped');
  const preview = await service.preview('c', AbortSignal.timeout(100));
  let release!: () => void;
  adapters.delete.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
  const first = service.confirm(preview.token, AbortSignal.timeout(100));
  await vi.waitFor(() => expect(adapters.delete).toHaveBeenCalledOnce());
  const second = service.confirm(preview.token, AbortSignal.timeout(100));
  release();
  await expect(first).resolves.toBe('deleted');
  await expect(second).rejects.toThrow('expired or already used');
  expect(adapters.delete).toHaveBeenCalledOnce();
});

it.each([
  ['stop', 'retained', 'stop'],
  ['delete', 'stopped', 'delete'],
] as const)('durably fences a failed %s action', async (_name, phase, failingAdapter) => {
  const { service, store, adapters } = setup(phase);
  (adapters[failingAdapter] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('failed'));
  const preview = await service.preview('c', AbortSignal.timeout(100));
  await expect(service.confirm(preview.token, AbortSignal.timeout(100))).rejects.toThrow('failed');
  expect(store.get('c')).toMatchObject({
    phase: 'failed',
    failure: 'failed',
    physicalSandboxId: 'p',
  });
});

it('durably fences a checkpoint when verification returns false', async () => {
  const { service, store, adapters } = setup('retained');
  adapters.verifyCheckpoint.mockResolvedValueOnce(false);
  const preview = await service.preview('c', AbortSignal.timeout(100));
  await expect(service.confirm(preview.token, AbortSignal.timeout(100))).rejects.toThrow(
    'checkpoint is unavailable',
  );
  expect(store.get('c')).toMatchObject({
    phase: 'failed',
    failure: 'OpenShell checkpoint is unavailable',
  });
});

it('fences a checkpoint after a protection recheck fails', async () => {
  const { service, store, adapters } = setup('retained');
  adapters.protect.mockResolvedValueOnce({ blockers: [] });
  adapters.protect.mockResolvedValueOnce({ blockers: [] });
  adapters.protect.mockRejectedValueOnce(new Error('protection lost'));
  const preview = await service.preview('c', AbortSignal.timeout(100));
  await expect(service.confirm(preview.token, AbortSignal.timeout(100))).rejects.toThrow(
    'protection lost',
  );
  expect(store.get('c')).toMatchObject({ phase: 'failed', failure: 'protection lost' });
});

it('never overwrites a newer lifecycle generation while fencing a failure', async () => {
  const { service, store, adapters } = setup('retained');
  adapters.checkpoint.mockImplementationOnce(async () => {
    const current = store.get('c')!;
    store.upsert({ ...current, phase: 'retained', generation: current.generation + 1 });
    throw new Error('late failure');
  });
  const preview = await service.preview('c', AbortSignal.timeout(100));
  await expect(service.confirm(preview.token, AbortSignal.timeout(100))).rejects.toThrow(
    'late failure',
  );
  expect(store.get('c')).toMatchObject({ phase: 'retained', failure: null });
});

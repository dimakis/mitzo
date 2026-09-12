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
it('requires a current identity and a single-use preview token', async () => {
  const { service, adapters } = setup();
  adapters.consent = () => false;
  const preview = await service.preview('c', AbortSignal.timeout(100));
  await expect(service.confirm(preview.token, AbortSignal.timeout(100))).resolves.toBe('deleted');
  await expect(service.confirm(preview.token, AbortSignal.timeout(100))).rejects.toThrow(
    'expired or already used',
  );
});
it('rejects out-of-band stopped version changes before deletion', async () => {
  const { service, sandbox } = setup();
  sandbox.resourceVersion = 'changed';
  const preview = await service.preview('c', AbortSignal.timeout(100));
  expect(preview.action).toBe('none');
  expect(preview.blockers).toContain('ambiguous_ownership');
});

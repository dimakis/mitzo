import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenShellWarmPool, type WarmSandbox } from '../openshell-warm-pool.js';
import {
  setOpenShellWarmPool,
  projectWarmPoolOwnership,
  warmPoolConversationName,
} from '../openshell-warm-pool-binding.js';
import { warmPoolScope } from '../openshell-warm-pool-runtime.js';
import { OpenShellRuntimeManager, type BoundOpenShellRuntimeConfig } from '../openshell-runtime.js';
let root = '',
  pool: OpenShellWarmPool | undefined;
afterEach(() => {
  setOpenShellWarmPool(null);
  vi.unstubAllEnvs();
  pool?.close();
  pool = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  root = mkdtempSync(join(tmpdir(), 'pool-binding-'));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', root);
  writeFileSync(join(root, 'policy'), 'policy');
  const config: BoundOpenShellRuntimeConfig = {
    cli: 'openshell',
    image: 'runtime:approved',
    policy: join(root, 'policy'),
    seed: join(root, 'mgmt'),
    workspace: 'default',
    gateway: 'isolated',
    gatewayInsecure: false,
    createDetached: true,
    sandboxIdLength: 13,
    workdir: '/sandbox/workspaces/mgmt',
    webSearch: 'disabled',
    serviceProviders: [],
    grantableServiceProviders: [],
    account: { kind: 'api', provider: 'work', model: 'model' },
  };
  let p: WarmSandbox | undefined;
  pool = new OpenShellWarmPool(join(root, 'pool.db'), {
    scope: warmPoolScope(config),
    available: true,
    reason: null,
    prepare: async (r) =>
      (p = { id: 'physical-one', name: r.name, poolId: r.id, phase: 'Ready', providers: [] }),
    inspect: async () => p,
    remove: async () => {
      p = undefined;
    },
    bind: async (_, provider) => {
      p!.providers = [provider];
    },
  });
  await pool.mutate({ action: 'prepare', revision: 0, requestId: 'prepare' });
  setOpenShellWarmPool(pool);
  return {
    config,
    physical: () => p!,
    raw: () => ({
      id: p!.id,
      name: p!.name,
      workspace: 'default',
      phase: 'Ready' as const,
      labels: { 'mitzo.warm_pool': p!.poolId },
    }),
  };
}
it('immutable pool labels become effective ownership only with a matching durable claimed identity', async () => {
  const f = await fixture();
  expect(() => projectWarmPoolOwnership(f.config, f.raw())).toThrow(/claimed/i);
  await pool!.claim('chat', 'work', AbortSignal.timeout(5000));
  expect(warmPoolConversationName(f.config, 'chat')).toBe(f.physical().name);
  const projected = projectWarmPoolOwnership(f.config, f.raw());
  expect(projected.labels['mitzo.account_provider']).toBe('work');
  expect(projected.labels['mitzo.conversation']).toMatch(/^[a-f0-9]{63}$/);
  expect(f.raw().labels).not.toHaveProperty('mitzo.account_provider');
  expect(() => projectWarmPoolOwnership(f.config, { ...f.raw(), id: 'replacement' })).toThrow(
    /identity/i,
  );
  expect(() =>
    warmPoolConversationName(
      { ...f.config, account: { ...f.config.account, provider: 'other' } },
      'chat',
    ),
  ).toThrow(/account/i);
});
it('manager reuses the recorded claimed name and retains all ordinary ownership checks', async () => {
  const f = await fixture();
  await pool!.claim('chat', 'work', AbortSignal.timeout(5000));
  const run = vi.fn(async (a: readonly string[]) =>
    a.includes('provider')
      ? 'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nwork service 0 0'
      : JSON.stringify(f.raw()),
  );
  const manager = new OpenShellRuntimeManager(f.config, run);
  const runtime = await manager.ensure('chat', AbortSignal.timeout(5000));
  expect(runtime.sandboxName).toBe(f.physical().name);
  expect(runtime.sandboxId).toBe('physical-one');
  expect(run.mock.calls.some(([a]) => a.includes('create'))).toBe(false);
  await expect(
    manager.inspect('another-chat', 'physical-one', AbortSignal.timeout(5000)),
  ).rejects.toThrow(/owned|binding|identity/);
});
it('only an explicit initial command claims a spare and later commands retain that owner', async () => {
  const f = await fixture();
  const run = vi.fn(async (a: readonly string[]) =>
    a.includes('provider')
      ? 'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nwork service 0 0'
      : JSON.stringify(f.raw()),
  );
  const manager = new OpenShellRuntimeManager(f.config, run);
  const runtime = await manager.ensure(
    'chat',
    AbortSignal.timeout(5000),
    undefined,
    undefined,
    undefined,
    'command-one',
  );
  expect(runtime.sandboxName).toBe(f.physical().name);
  expect(pool!.lookup('chat', 'work')?.state).toBe('claimed');
  expect(pool!.snapshot().spares).toHaveLength(0);
  await manager.ensure('chat', AbortSignal.timeout(5000));
  expect(pool!.snapshot().owned).toHaveLength(1);
});

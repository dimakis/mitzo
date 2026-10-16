import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenShellWarmPool } from '../openshell-warm-pool.js';
import { createWarmPoolAdapter } from '../openshell-warm-pool-runtime.js';
import { setOpenShellWarmPool, warmPoolConnectionAccount } from '../openshell-warm-pool-binding.js';
import { OpenShellRuntimeManager, type BoundOpenShellRuntimeConfig } from '../openshell-runtime.js';

let root = '';
let pool: OpenShellWarmPool | undefined;
afterEach(() => {
  setOpenShellWarmPool(null);
  pool?.close();
  pool = undefined;
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});
async function fixture(historical = false) {
  root = mkdtempSync(join(tmpdir(), 'pool-upgrade-'));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', root);
  writeFileSync(join(root, 'policy'), 'policy');
  const config: BoundOpenShellRuntimeConfig = {
    cli: 'openshell',
    image: 'runtime:original',
    policy: join(root, 'policy'),
    seed: join(root, 'seed'),
    workspace: 'default',
    gateway: 'isolated',
    gatewayInsecure: false,
    createDetached: true,
    sandboxIdLength: 13,
    workdir: '/sandbox/workspaces/mgmt',
    webSearch: 'disabled',
    serviceProviders: [],
    grantableServiceProviders: [],
    account: { kind: 'api', provider: 'work', model: 'offline' },
    connectionAccountId: 'account-a',
  };
  const physical = new Map<
    string,
    {
      id: string;
      name: string;
      workspace: string;
      phase: string;
      labels: Record<string, string>;
    }
  >();
  const providers = new Map<string, string[]>();
  const run = vi.fn(async (args: readonly string[]) => {
    if (args.includes('create')) {
      const name = args[args.indexOf('--name') + 1];
      const origin = args[args.indexOf('--label') + 1].split('=')[1];
      const resource = {
        id: crypto.randomUUID(),
        name,
        workspace: 'default',
        phase: 'Ready',
        labels: { 'mitzo.warm_pool': origin },
      };
      physical.set(name, resource);
      providers.set(name, []);
      return JSON.stringify(resource);
    }
    if (args.includes('provider')) {
      if (args.includes('attach')) {
        providers.get(args.at(-2)!)!.push(args.at(-1)!);
        return '{}';
      }
      const attached = providers.get(args.at(-1)!) ?? [];
      return attached.length
        ? 'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n' +
            attached.map((x) => x + ' service 0 0').join('\n')
        : 'No providers attached to sandbox ' + args.at(-1) + '.';
    }
    if (args.includes('upload')) return '{}';
    if (args.includes('delete')) {
      physical.delete(args.at(-1)!);
      return '{}';
    }
    const name = args[args.indexOf('get') + 1];
    if (!physical.has(name)) throw Error('404 not found');
    return JSON.stringify(physical.get(name));
  });
  const seed = async () => ({ seed: config.seed, cleanup: () => {} });
  const path = join(root, 'pool.db');
  const makeAdapter = (c: BoundOpenShellRuntimeConfig) => {
    const adapter = createWarmPoolAdapter(c, run, seed);
    if (historical && c === config) delete adapter.runtimeAuthority;
    return adapter;
  };
  pool = new OpenShellWarmPool(path, makeAdapter(config));
  await pool.mutate({
    action: 'settings',
    revision: 0,
    requestId: 'capacity',
    settings: { ...pool.snapshot().settings, capacity: 2 },
  });
  await pool.mutate({
    action: 'prepare',
    revision: pool.snapshot().revision,
    requestId: 'prepare',
  });
  const claimed = (await pool.claim(
    'chat',
    'work',
    AbortSignal.timeout(5000),
    undefined,
    [],
    'account-a',
  ))!;
  const spare = pool.snapshot().spares[0];
  const reopen = (next: BoundOpenShellRuntimeConfig) => {
    pool!.close();
    pool = new OpenShellWarmPool(path, makeAdapter(next));
    pool.recoverInterrupted();
    setOpenShellWarmPool(pool);
    return new OpenShellRuntimeManager(next, run);
  };
  return { config, claimed, spare, physical, run, reopen };
}
it.each(['image', 'stack', 'policy'] as const)(
  'reopens a durable claim for migration and retires obsolete spares after a %s update',
  async (kind) => {
    const f = await fixture();
    const next = { ...f.config };
    if (kind === 'image') next.image = 'runtime:updated';
    if (kind === 'stack')
      next.seedStackManifest = { runtime: { revision: 'updated' } } as unknown as NonNullable<
        typeof next.seedStackManifest
      >;
    if (kind === 'policy') writeFileSync(next.policy, 'updated policy');
    const manager = f.reopen(next);
    const runtime = {
      sandboxName: f.claimed.name,
      sandboxId: f.claimed.physicalId!,
      workdir: next.workdir,
      appServerCommand: '/sandbox/run-mitzo-app-server' as const,
      cli: next.cli,
      gateway: next.gateway,
      workspace: next.workspace,
      gatewayInsecure: false,
    };
    // This is the actual physical ownership gate used before retained migration.
    await expect(
      manager.withMigrationProviderPolicyFence(
        'chat',
        runtime,
        AbortSignal.timeout(5000),
        async (assertUnqueued) => {
          assertUnqueued();
          return manager
            .forSandbox(runtime.sandboxName)
            .inspect('chat', runtime.sandboxId, AbortSignal.timeout(5000));
        },
      ),
    ).resolves.toMatchObject({ id: f.claimed.physicalId, phase: 'Ready' });
    await expect(
      warmPoolConnectionAccount(
        f.physical.get(f.claimed.name)!,
        'isolated',
        'default',
        AbortSignal.timeout(5000),
      ),
    ).resolves.toBe('account-a');
    // An old recipe can be inspected/retired, but never offered to a new conversation.
    expect(
      await pool!.claim('new-chat', 'work', AbortSignal.timeout(5000), undefined, [], 'account-a'),
    ).toBeNull();
    await pool!.mutate({
      action: 'recheck',
      id: f.spare.id,
      revision: pool!.snapshot().revision,
      requestId: 'recheck-old',
    });
    expect((await pool!.observe(AbortSignal.timeout(5000))).spares[0].observedState).toBe(
      'unverified',
    );
    await pool!.mutate({
      action: 'replace',
      id: f.spare.id,
      revision: pool!.snapshot().revision,
      requestId: 'replace-old',
    });
    expect(f.physical.has(f.spare.name)).toBe(false);
    expect(pool!.snapshot().spares.every((r) => r.scope === pool!.adapter.scope)).toBe(true);
    expect(pool!.lookup('chat', 'work')?.physicalId).toBe(f.claimed.physicalId);
  },
);
it('reconciles an enabled reopened pool by retiring obsolete Ready spares before refilling', async () => {
  const f = await fixture();
  await pool!.mutate({
    action: 'settings',
    revision: pool!.snapshot().revision,
    requestId: 'enable',
    settings: { ...pool!.snapshot().settings, enabled: true },
  });
  const oldNames = pool!.snapshot().spares.map((r) => r.name);
  f.reopen({ ...f.config, image: 'runtime:updated' });
  await pool!.reconcile();
  expect(pool!.snapshot().spares).toHaveLength(2);
  expect(pool!.snapshot().spares.every((r) => r.scope === pool!.adapter.scope)).toBe(true);
  expect(oldNames.every((name) => !f.physical.has(name))).toBe(true);
  expect(f.physical.has(f.claimed.name)).toBe(true);
});
it.each(['gateway', 'workspace', 'cli', 'workdir', 'account', 'physical'] as const)(
  'still refuses a changed %s when reopening an upgraded recipe',
  async (kind) => {
    const f = await fixture();
    const next = { ...f.config, image: 'runtime:updated' };
    if (kind === 'gateway') next.gateway = 'another';
    if (kind === 'workspace') next.workspace = 'another';
    if (kind === 'cli') next.cli = 'another';
    if (kind === 'workdir') next.workdir = '/another';
    if (kind === 'account') next.connectionAccountId = 'account-b';
    if (kind === 'physical') f.physical.get(f.claimed.name)!.id = 'replacement';
    const manager = f.reopen(next);
    await expect(
      manager.inspect('chat', f.claimed.physicalId!, AbortSignal.timeout(5000)),
    ).rejects.toThrow(/identity|authority|binding|unverified/);
    if (['gateway', 'workspace', 'cli', 'workdir'].includes(kind)) {
      f.run.mockClear();
      await expect(
        pool!.mutate({
          action: 'remove',
          id: f.spare.id,
          revision: pool!.snapshot().revision,
          requestId: 'wrong-authority',
        }),
      ).rejects.toThrow(/identity|authority|scope/);
      expect(f.run).not.toHaveBeenCalled();
      expect(f.physical.has(f.spare.name)).toBe(true);
    }
  },
);

it('does not invent authority for historical rows after a recipe change', async () => {
  const f = await fixture(true);
  expect(f.claimed.runtimeAuthority).toBeUndefined();
  const original = f.reopen({ ...f.config });
  await expect(
    original.inspect('chat', f.claimed.physicalId!, AbortSignal.timeout(5000)),
  ).resolves.toMatchObject({ id: f.claimed.physicalId });
  const updated = f.reopen({ ...f.config, image: 'runtime:updated' });
  await expect(
    updated.inspect('chat', f.claimed.physicalId!, AbortSignal.timeout(5000)),
  ).rejects.toThrow(/unverified|authority|identity/);
  await expect(
    pool!.mutate({
      action: 'remove',
      id: f.spare.id,
      revision: pool!.snapshot().revision,
      requestId: 'historical-scope',
    }),
  ).rejects.toThrow(/authority|identity/);
  expect(f.physical.has(f.spare.name)).toBe(true);
  expect(pool!.lookup('chat', 'work')!.runtimeAuthority).toBeUndefined();
});
it('keeps uncertain obsolete spares reserved while replacing only settled Ready spares', async () => {
  const f = await fixture();
  await pool!.mutate({
    action: 'settings',
    revision: pool!.snapshot().revision,
    requestId: 'enable',
    settings: { ...pool!.snapshot().settings, enabled: true },
  });
  f.physical.get(f.spare.name)!.phase = 'Error';
  await expect(
    pool!.claim('failed-chat', 'work', AbortSignal.timeout(5000), undefined, [], 'account-a'),
  ).rejects.toThrow(/not Ready/);
  expect(pool!.snapshot().spares.find((r) => r.id === f.spare.id)?.state).toBe('uncertain');
  f.reopen({ ...f.config, image: 'runtime:updated' });
  await pool!.reconcile();
  expect(pool!.snapshot().spares).toHaveLength(2);
  expect(pool!.snapshot().spares.find((r) => r.id === f.spare.id)?.state).toBe('uncertain');
  expect(f.physical.has(f.spare.name)).toBe(true);
  expect(pool!.snapshot().spares.filter((r) => r.scope === pool!.adapter.scope)).toHaveLength(1);
  expect(
    (await pool!.observe(AbortSignal.timeout(5000))).spares.find((r) => r.id === f.spare.id)
      ?.failure,
  ).toMatch(/not Ready/);
});

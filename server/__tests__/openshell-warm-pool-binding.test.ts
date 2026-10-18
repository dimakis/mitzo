import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenShellWarmPool, type WarmSandbox } from '../openshell-warm-pool.js';
import {
  setOpenShellWarmPool,
  projectWarmPoolOwnership,
  warmPoolConversationName,
  warmPoolConnectionAccount,
} from '../openshell-warm-pool-binding.js';
import {
  initializeOpenShellLifecycle,
  registerOpenShellLifecycle,
} from '../openshell-lifecycle-controller.js';
import { warmPoolScope } from '../openshell-warm-pool-runtime.js';
import {
  OpenShellRuntimeManager,
  sandboxNameForConversation,
  type BoundOpenShellRuntimeConfig,
} from '../openshell-runtime.js';
let root = '',
  pool: OpenShellWarmPool | undefined;
afterEach(() => {
  setOpenShellWarmPool(null);
  vi.unstubAllEnvs();
  pool?.close();
  pool = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});
async function fixture(lifecycleCli = false) {
  root = mkdtempSync(join(tmpdir(), 'pool-binding-'));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', root);
  writeFileSync(join(root, 'policy'), 'policy');
  const config: BoundOpenShellRuntimeConfig = {
    cli: lifecycleCli ? join(root, 'openshell-fixture') : 'openshell',
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
  const projected: { labels: Record<string, string> } = projectWarmPoolOwnership(f.config, f.raw());
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
  const run = vi.fn(async (a: readonly string[]) => {
    if (a.includes('provider')) return 'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nwork service 0 0';
    return JSON.stringify(f.raw());
  });
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
  const run = vi.fn(async (a: readonly string[]) => {
    if (a.includes('provider')) return 'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nwork service 0 0';
    if (a.includes(f.physical().name)) return JSON.stringify(f.raw());
    throw Error('not found');
  });
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
it.each([true, false])(
  'applies saved cold limits only to an explicit eligible first command: %s',
  async (explicit) => {
    const f = await fixture();
    await pool!.mutate({
      action: 'settings',
      revision: pool!.snapshot().revision,
      requestId: 'resources',
      settings: { ...pool!.snapshot().settings, cpu: 4, memoryGiB: 8 },
    });
    let created: Record<string, unknown> | undefined;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('provider')) return 'No providers attached to sandbox fixture.';
      if (args.includes('create')) {
        const name = args[args.indexOf('--name') + 1],
          labels: Record<string, string> = {};
        args.forEach((x, i) => {
          if (x === '--label') {
            const [key, value] = args[i + 1].split('=');
            labels[key] = value;
          }
        });
        created = { id: 'cold-physical', name, workspace: 'default', phase: 'Ready', labels };
        return JSON.stringify(created);
      }
      if (!created) throw Error('not found');
      return JSON.stringify(created);
    });
    const manager = new OpenShellRuntimeManager(f.config, run);
    await manager.ensure(
      'cold-chat',
      AbortSignal.timeout(5000),
      undefined,
      undefined,
      undefined,
      explicit ? 'first-command' : undefined,
    );
    const args = run.mock.calls.find(([a]) => a.includes('create'))![0];
    if (explicit) {
      expect(args[args.indexOf('--cpu') + 1]).toBe('4');
      expect(args[args.indexOf('--memory') + 1]).toBe('8Gi');
    } else {
      expect(args).not.toContain('--cpu');
      expect(args).not.toContain('--memory');
    }
  },
);

it.each([false, true])(
  'initial retry reuses an existing current/legacy sandbox before claiming: legacy=%s',
  async (legacy) => {
    const f = await fixture();
    const hash = createHash('sha256').update('retry-chat').digest('hex');
    const name = legacy ? 'mitzo-' + hash.slice(0, 24) : sandboxNameForConversation('retry-chat');
    const retained = {
      id: 'retained-physical',
      name,
      workspace: 'default',
      phase: 'Ready',
      labels: {
        'mitzo.conversation': legacy ? hash : hash.slice(0, 63),
        'mitzo.account_provider': 'work',
      },
    };
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('provider')) return 'No providers attached to sandbox ' + name + '.';
      if (args.includes('get') && args.includes(name)) return JSON.stringify(retained);
      throw Error('not found');
    });
    const manager = new OpenShellRuntimeManager(f.config, run);
    const runtime = await manager.ensure(
      'retry-chat',
      AbortSignal.timeout(5000),
      undefined,
      undefined,
      undefined,
      'retry-command',
    );
    expect(runtime.sandboxId).toBe('retained-physical');
    expect(pool!.snapshot().owned).toHaveLength(0);
    expect(pool!.snapshot().spares).toHaveLength(1);
  },
);

it('persists the connection account at command claim and rejects account reassignment on reuse', async () => {
  const f = await fixture();
  f.config.connectionAccountId = 'personal-id';
  const run = vi.fn(async (a: readonly string[]) => {
    if (a.includes('provider')) return 'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nwork service 0 0';
    if (a.includes(f.physical().name)) return JSON.stringify(f.raw());
    throw Error('not found');
  });
  await new OpenShellRuntimeManager(f.config, run).ensure(
    'chat',
    AbortSignal.timeout(5000),
    undefined,
    undefined,
    undefined,
    'command',
  );
  expect(pool!.lookup('chat', 'work')).toHaveProperty('connectionAccountId', 'personal-id');
  expect(projectWarmPoolOwnership(f.config, f.raw()).labels).toHaveProperty(
    'mitzo.connection_account',
    'personal-id',
  );
  expect(() =>
    warmPoolConversationName({ ...f.config, connectionAccountId: 'different-id' }, 'chat'),
  ).toThrow(/account/i);
});

it('connection cleanup rejects changed physical identity, missing account and another gateway scope', async () => {
  const f = await fixture();
  pool!.adapter.connectionAuthority = { gateway: 'isolated', workspace: 'default' };
  await pool!.claim('chat', 'work', AbortSignal.timeout(5000), undefined, undefined, 'work-id');
  expect(
    await warmPoolConnectionAccount(f.raw(), 'isolated', 'default', AbortSignal.timeout(5000)),
  ).toBe('work-id');
  await expect(
    warmPoolConnectionAccount(f.raw(), 'other', 'default', AbortSignal.timeout(5000)),
  ).rejects.toThrow(/unverified/);
  f.physical().id = 'replacement';
  await expect(
    warmPoolConnectionAccount(f.raw(), 'isolated', 'default', AbortSignal.timeout(5000)),
  ).rejects.toThrow(/identity/);
});

it('production lifecycle previews use the durable account of a normally claimed spare', async () => {
  const f = await fixture(true);
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  await pool!.claim('chat', 'work', AbortSignal.timeout(5000), undefined, [], 'account-a');
  // Exercise the actual production controller and runtime ownership inspection;
  // only the CLI process is replaced with an offline physical-resource fixture.
  writeFileSync(
    f.config.cli,
    '#!/usr/bin/env node\nprocess.stdout.write(' + JSON.stringify(JSON.stringify(f.raw())) + ');\n',
    { mode: 0o700 },
  );
  const lifecycle = initializeOpenShellLifecycle(f.config, {
    registry: { findBySessionId: () => undefined, entries: function* () {} },
    eventStore: { getSession: () => ({}) },
    taskStore: { getTree: () => [], getTelosExecutionBinding: () => null },
    queue: () => ({ queued: 0, running: 0, recovery: false }),
  })!;
  try {
    registerOpenShellLifecycle(
      'chat',
      {
        sandboxName: f.physical().name,
        sandboxId: f.physical().id,
        workdir: f.config.workdir,
        appServerCommand: '/sandbox/run-mitzo-app-server',
        cli: f.config.cli,
        gateway: f.config.gateway,
        workspace: f.config.workspace,
        gatewayInsecure: false,
      },
      {
        accountId: 'account-a',
        accountLabel: 'Offline fixture',
        provider: 'codex',
        model: 'offline',
        profileRevision: 'r1',
      },
      f.config.account,
      'thread',
    );
    await expect(
      lifecycle.service.preview('chat', AbortSignal.timeout(5000)),
    ).resolves.toMatchObject({
      action: 'stop',
      blockers: [],
      record: { identity: { accountId: 'account-a' } },
    });
    const record = lifecycle.store.get('chat')!;
    lifecycle.store.upsert({
      ...record,
      generation: record.generation + 1,
      identity: { ...record.identity!, accountId: 'account-b' },
    });
    await expect(lifecycle.service.preview('chat', AbortSignal.timeout(5000))).rejects.toThrow(
      /physical\/account identity differs/,
    );
  } finally {
    lifecycle.store.close();
  }
});

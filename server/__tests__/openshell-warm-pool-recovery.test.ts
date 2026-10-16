import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenShellWarmPool } from '../openshell-warm-pool.js';
import { createWarmPoolAdapter } from '../openshell-warm-pool-runtime.js';
import { setOpenShellWarmPool } from '../openshell-warm-pool-binding.js';
import { OpenShellRuntimeManager, type BoundOpenShellRuntimeConfig } from '../openshell-runtime.js';
import {
  initializeOpenShellLifecycle,
  openShellLifecyclePhaseCounts,
} from '../openshell-lifecycle-controller.js';
let root = '',
  pool: OpenShellWarmPool | undefined;
afterEach(() => {
  setOpenShellWarmPool(null);
  pool?.close();
  pool = undefined;
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});
async function fixture(failure: 'upload' | 'attachment' | 'inspection' | null, cli = false) {
  root = mkdtempSync(join(tmpdir(), 'pool-recovery-'));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', root);
  writeFileSync(join(root, 'policy'), 'policy');
  const config: BoundOpenShellRuntimeConfig = {
    cli: cli ? join(root, 'offline-cli') : 'openshell',
    image: 'runtime:approved',
    policy: join(root, 'policy'),
    seed: join(root, 'seed'),
    workspace: 'default',
    gateway: 'isolated',
    gatewayInsecure: false,
    createDetached: true,
    sandboxIdLength: 13,
    workdir: '/sandbox/workspaces/mgmt',
    webSearch: 'disabled',
    serviceProviders: ['github'],
    grantableServiceProviders: [],
    account: { kind: 'api', provider: 'work', model: 'offline' },
    connectionAccountId: 'account-a',
  };
  const physical = new Map<
    string,
    { id: string; name: string; workspace: string; phase: string; labels: Record<string, string> }
  >();
  const attached = new Map<string, string[]>();
  let failed = false,
    completedReads = 0;
  const run = vi.fn(async (args: readonly string[]) => {
    if (args.includes('create')) {
      const name = args[args.indexOf('--name') + 1],
        origin = args[args.indexOf('--label') + 1].split('=')[1];
      const value = {
        id: crypto.randomUUID(),
        name,
        workspace: 'default',
        phase: 'Ready',
        labels: { 'mitzo.warm_pool': origin },
      };
      physical.set(name, value);
      attached.set(name, []);
      return JSON.stringify(value);
    }
    if (args.includes('upload')) {
      if (failure === 'upload' && !failed) {
        failed = true;
        throw Error('Transient upload failure');
      }
      return '{}';
    }
    if (args.includes('provider')) {
      if (args.includes('attach')) {
        attached.get(args.at(-2)!)!.push(args.at(-1)!);
        if (failure === 'attachment' && !failed) {
          failed = true;
          throw Error('Attachment response lost');
        }
        return '{}';
      }
      const names = attached.get(args.at(-1)!) ?? [];
      return names.length
        ? 'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n' +
            names.map((x) => x + ' service 0 0').join('\n')
        : 'No providers attached to sandbox ' + args.at(-1) + '.';
    }
    if (args.includes('list')) return JSON.stringify([...physical.values()]);
    const name = args[args.indexOf('get') + 1],
      value = physical.get(name);
    if (!value) throw Error('404 not found');
    if (
      failure === 'inspection' &&
      attached.get(name)?.length === 2 &&
      ++completedReads === 2 &&
      !failed
    ) {
      failed = true;
      throw Error('Final inspection response lost');
    }
    return JSON.stringify(value);
  });
  const adapter = createWarmPoolAdapter(config, run, async () => ({
      seed: config.seed,
      cleanup: () => {},
    })),
    path = join(root, 'pool.db');
  pool = new OpenShellWarmPool(path, adapter);
  setOpenShellWarmPool(pool);
  await pool.mutate({ action: 'prepare', revision: 0, requestId: 'prepare' });
  const claim = (chat = 'chat', account = 'account-a') =>
    pool!.claim(chat, 'work', AbortSignal.timeout(5000), config.seed, ['github'], account);
  const reopen = () => {
    pool!.close();
    pool = new OpenShellWarmPool(path, adapter);
    pool.recoverInterrupted();
    setOpenShellWarmPool(pool);
  };
  return { config, physical, attached, run, claim, reopen };
}
it.each(['upload', 'attachment', 'inspection'] as const)(
  'retries a %s failure after reopening the ledger without replacing or recycling the owned resource',
  async (failure) => {
    const f = await fixture(failure);
    await expect(f.claim()).rejects.toThrow();
    const owned = pool!.lookup('chat', 'work')!;
    expect(owned.state).toBe('uncertain');
    expect(pool!.snapshot().spares).toHaveLength(0);
    f.reopen();
    const runtime = await new OpenShellRuntimeManager(f.config, f.run).ensure(
      'chat',
      AbortSignal.timeout(5000),
      undefined,
      { seed: f.config.seed, cleanup: () => {} },
      undefined,
      'retry-command',
    );
    expect(runtime.sandboxId).toBe(owned.physicalId);
    expect(runtime.sandboxName).toBe(owned.name);
    expect(pool!.lookup('chat', 'work')).toMatchObject({
      id: owned.id,
      physicalId: owned.physicalId,
      conversationId: 'chat',
      connectionAccountId: 'account-a',
      state: 'claimed',
      failure: null,
    });
    expect(f.run.mock.calls.filter(([a]) => a.includes('create'))).toHaveLength(1);
    expect(f.run.mock.calls.filter(([a]) => a.includes('attach')).map(([a]) => a.at(-1))).toEqual([
      'work',
      'github',
    ]);
  },
);
it.each(['account', 'physical', 'provider', 'recipe', 'cancel'] as const)(
  'retains failed ownership and refuses recovery after a changed %s',
  async (kind) => {
    const f = await fixture('upload');
    await expect(f.claim()).rejects.toThrow();
    const owned = pool!.lookup('chat', 'work')!,
      next = { ...f.config };
    if (kind === 'account') next.connectionAccountId = 'other';
    if (kind === 'physical') f.physical.get(owned.name)!.id = 'replacement';
    if (kind === 'provider') f.attached.get(owned.name)!.push('unexpected');
    if (kind === 'recipe') next.image = 'runtime:updated';
    f.run.mockClear();
    await expect(
      new OpenShellRuntimeManager(next, f.run).ensure(
        'chat',
        kind === 'cancel' ? AbortSignal.abort(Error('Cancelled')) : AbortSignal.timeout(5000),
        undefined,
        { seed: next.seed, cleanup: () => {} },
        undefined,
        'retry',
      ),
    ).rejects.toThrow();
    expect(pool!.lookup('chat', 'work')).toMatchObject({
      id: owned.id,
      physicalId: owned.physicalId,
      conversationId: 'chat',
      state: 'uncertain',
    });
    expect(pool!.snapshot().spares).toHaveLength(0);
    expect(
      f.run.mock.calls.some(
        ([a]) =>
          a.includes('create') ||
          a.includes('upload') ||
          a.includes('attach') ||
          a.includes('delete'),
      ),
    ).toBe(false);
  },
);
it('counts exact pooled ownership across accounts in production telemetry without granting execution authority', async () => {
  const f = await fixture(null, true),
    first = (await f.claim())!;
  await pool!.mutate({
    action: 'prepare',
    revision: pool!.snapshot().revision,
    requestId: 'second',
  });
  const second = (await f.claim('chat-b', 'account-b'))!;
  await pool!.mutate({
    action: 'prepare',
    revision: pool!.snapshot().revision,
    requestId: 'neutral',
  });
  f.physical.set('foreign', {
    id: 'foreign',
    name: 'foreign',
    workspace: 'default',
    phase: 'Ready',
    labels: { 'mitzo.conversation': 'other', 'mitzo.account_provider': 'other' },
  });
  writeFileSync(
    f.config.cli,
    '#!/usr/bin/env node\nprocess.stdout.write(' +
      JSON.stringify(JSON.stringify([...f.physical.values()])) +
      ');\n',
    { mode: 0o700 },
  );
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  const lifecycle = initializeOpenShellLifecycle(f.config, {
    registry: { findBySessionId: () => undefined, entries: function* () {} },
    eventStore: { getSession: () => ({}) },
    taskStore: { getTree: () => [] },
    queue: () => ({ queued: 0, running: 0, recovery: false }),
    accountProviders: () => ['work'],
  })!;
  try {
    await expect(openShellLifecyclePhaseCounts(AbortSignal.timeout(5000))).resolves.toEqual({
      phaseCounts: { Ready: 2 },
      providerErrors: {},
    });
    await expect(
      new OpenShellRuntimeManager(f.config, f.run).inspect(
        'chat-b',
        second.physicalId!,
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow(/account/);
    expect(f.physical.get(first.name)!.labels).toEqual({ 'mitzo.warm_pool': first.id });
  } finally {
    lifecycle.store.close();
  }
});
it('does not silently count a substituted pooled physical resource', async () => {
  const f = await fixture(null),
    owned = (await f.claim())!;
  f.physical.get(owned.name)!.id = 'replacement';
  await expect(
    new OpenShellRuntimeManager({ ...f.config, connectionAccountId: undefined }, f.run).inventory(
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow(/identity/);
});

it('counts a failed claim as physical usage without allowing it to execute before recovery', async () => {
  const f = await fixture('upload');
  await expect(f.claim()).rejects.toThrow();
  const owned = pool!.lookup('chat', 'work')!;
  const telemetry = new OpenShellRuntimeManager(
    { ...f.config, connectionAccountId: undefined },
    f.run,
  );
  await expect(telemetry.inventory(AbortSignal.timeout(5000))).resolves.toEqual([
    expect.objectContaining({
      id: owned.physicalId,
      labels: expect.objectContaining({ 'mitzo.connection_account': 'account-a' }),
    }),
  ]);
  await expect(
    new OpenShellRuntimeManager(f.config, f.run).inspect(
      'chat',
      owned.physicalId!,
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow(/unverified/);
  expect(pool!.lookup('chat', 'work')?.state).toBe('uncertain');
});

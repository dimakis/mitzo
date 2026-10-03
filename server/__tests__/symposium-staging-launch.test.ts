import { afterEach, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchStagingCustodian } from '../symposium-staging-launch.js';
import { openStagingRegistry } from '../symposium-staging-registry.js';
import {
  finishCustodianRetirement,
  writeCustodianRetirementReceipt,
} from '../symposium-custodian-retirement.js';
import type { OwnedReleasePlan } from '../symposium-owned-release.js';
import type { SymposiumCustodianConstructorHooks } from '../symposium-custodian-main.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'staging-launch-')));
  chmodSync(root, 0o700);
  roots.push(root);
  const plan = {
    planDirectory: join(root, 'plan'),
    releaseRoot: join(root, 'release'),
    repositoryPath: join(root, 'repo'),
    configPath: join(root, 'config.json'),
    appHome: join(root, 'home'),
    sourceCommit: 'a'.repeat(40),
    buildSha256: 'b'.repeat(64),
    configSha256: 'c'.repeat(64),
  } as OwnedReleasePlan;
  const registration = {
    registryDirectory: join(root, 'registry'),
    capacity: 1,
    ownerChat: 'chat-1',
    purpose: 'test',
    retentionReason: 'diagnostic',
    reviewAfter: Date.now() + 60000,
  };
  for (const dir of [
    plan.planDirectory,
    plan.releaseRoot,
    plan.repositoryPath,
    plan.appHome,
    registration.registryDirectory,
    join(root, 'podman'),
    join(root, 'seed'),
  ])
    mkdirSync(dir, { mode: 0o700 });
  const stateParent = join(root, 'state');
  writeFileSync(
    plan.configPath,
    JSON.stringify({
      gateway: { stateParent },
      podman: { environment: { HOME: join(root, 'podman') } },
      runtime: { seed: join(root, 'seed') },
    }),
    { mode: 0o600 },
  );
  mkdirSync(stateParent, { mode: 0o700 });
  const gatewayStateDirectory = join(stateParent, 'gateway');
  mkdirSync(gatewayStateDirectory, { mode: 0o700 });
  return { root, plan, registration, stateParent, gatewayStateDirectory };
}
it('reserves before original launch intent and records same-owner replacement through terminal retirement', async () => {
  const f = fixture();
  const order: string[] = [];
  await launchStagingCustodian(f.plan, f.registration, {
    verify() {
      order.push('verify');
    },
    claim() {
      const r = openStagingRegistry(f.registration.registryDirectory, 1);
      expect(r.list()[0].state).toBe('launch_uncertain');
      r.close();
      order.push('claim');
    },
    async run(hooks: SymposiumCustodianConstructorHooks) {
      order.push('run');
      hooks.observeController!(
        {
          instanceId: 'original',
          epoch: 1,
          custodianPid: 1,
          controllerPid: 2,
          state: 'active',
          scope: 'fresh-retained-sessions',
        },
        () => {},
      );
      hooks.observeController!(
        {
          instanceId: 'original',
          epoch: 2,
          custodianPid: 1,
          controllerPid: 3,
          state: 'active',
          scope: 'fresh-retained-sessions',
        },
        () => {},
      );
      await finishCustodianRetirement(
        {
          begin() {},
          async retireRuntimes() {},
          async drainHost() {},
          async closeHost() {},
          record() {
            writeCustodianRetirementReceipt({
              stateParent: f.stateParent,
              gatewayStateDirectory: f.gatewayStateDirectory,
              instanceId: 'original',
              controllerGeneration: 2,
            });
          },
        },
        new AbortController().signal,
        (state) => hooks.observeRetirement!(state, f.stateParent),
      );
    },
  });
  expect(order).toEqual(['verify', 'claim', 'verify', 'run']);
  const r = openStagingRegistry(f.registration.registryDirectory, 1);
  expect(r.list()[0]).toMatchObject({
    state: 'retired',
    instanceId: 'original',
    controllerGeneration: 2,
  });
  r.close();
});
it.each(['claim', 'bootstrap', 'cleanup'] as const)(
  'retains uncertain %s and refuses a silent successor',
  async (failure) => {
    const f = fixture();
    const deps = {
      verify() {},
      claim() {
        if (failure === 'claim') throw Error('interrupted');
      },
      async run(hooks: SymposiumCustodianConstructorHooks) {
        if (failure === 'bootstrap') throw Error('interrupted');
        hooks.observeController!(
          {
            instanceId: 'original',
            epoch: 1,
            custodianPid: 1,
            controllerPid: 2,
            state: 'active',
            scope: 'fresh-retained-sessions',
          },
          () => {},
        );
        await finishCustodianRetirement(
          {
            begin() {},
            async retireRuntimes() {
              throw Error('physical cleanup uncertain');
            },
            async drainHost() {},
            async closeHost() {},
            record() {},
          },
          new AbortController().signal,
          (state) => hooks.observeRetirement!(state, f.stateParent),
        );
      },
    };
    await expect(launchStagingCustodian(f.plan, f.registration, deps)).rejects.toThrow();
    await expect(
      launchStagingCustodian(
        { ...f.plan, planDirectory: join(f.root, 'next') },
        f.registration,
        deps,
      ),
    ).rejects.toThrow('capacity');
    const r = openStagingRegistry(f.registration.registryDirectory, 1);
    expect(r.list()[0].state).not.toBe('retired');
    r.close();
  },
);
it('refuses stale original controller before recording observed activity', async () => {
  const f = fixture();
  await expect(
    launchStagingCustodian(f.plan, f.registration, {
      verify() {},
      claim() {},
      async run(hooks) {
        hooks.observeController!(
          {
            instanceId: 'original',
            epoch: 1,
            custodianPid: 1,
            controllerPid: 2,
            state: 'active',
            scope: 'fresh-retained-sessions',
          },
          () => {
            throw Error('creation lost');
          },
        );
      },
    }),
  ).rejects.toThrow('creation lost');
  const r = openStagingRegistry(f.registration.registryDirectory, 1);
  expect(r.list()[0].instanceId).toBeNull();
  r.close();
});
it('reports uncertain receipt persistence and never announces retired on failed recording', async () => {
  const observe = vi.fn();
  await expect(
    finishCustodianRetirement(
      {
        begin() {},
        async retireRuntimes() {},
        async drainHost() {},
        async closeHost() {},
        record() {
          throw Error('fsync failed');
        },
      },
      new AbortController().signal,
      observe,
    ),
  ).rejects.toThrow('fsync failed');
  expect(observe.mock.calls.map(([state]) => state)).toEqual(['retiring', 'uncertain']);
});

it.each([
  'release',
  'repo',
  'gateway',
  'plan',
  'home',
  'podman',
  'seed',
  'ancestor',
  'descendant',
] as const)('rejects %s registry overlap before registry or launch effects', async (target) => {
  const f = fixture();
  const paths = {
    release: f.plan.releaseRoot,
    repo: f.plan.repositoryPath,
    gateway: f.stateParent,
    plan: f.plan.planDirectory,
    home: f.plan.appHome,
    podman: join(f.root, 'podman'),
    seed: join(f.root, 'seed'),
    ancestor: f.root,
    descendant: join(f.plan.releaseRoot, 'nested'),
  };
  const registryDirectory = paths[target];
  if (target === 'descendant') mkdirSync(registryDirectory, { mode: 0o700 });
  const claim = vi.fn();
  const run = vi.fn(async () => {});
  await expect(
    launchStagingCustodian(
      f.plan,
      { ...f.registration, registryDirectory },
      { verify() {}, claim, run },
    ),
  ).rejects.toThrow('overlap');
  expect(claim).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(existsSync(join(registryDirectory, 'staging.db'))).toBe(false);
});

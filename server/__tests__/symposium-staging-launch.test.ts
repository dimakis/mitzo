import { afterEach, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  symlinkSync,
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
  const inputFile = (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { mode: 0o700 });
    const path = join(dir, 'input');
    writeFileSync(path, 'synthetic only', { mode: 0o600 });
    return path;
  };
  const digest = 'a'.repeat(64);
  const config = {
    gateway: {
      stateParent,
      executable: inputFile('gateway-executable'),
      executableSha256: digest,
      cliExecutable: inputFile('gateway-cli'),
      cliSha256: digest,
      systemCaBundle: inputFile('system-ca'),
      gateway: 'test',
      workspace: 'test',
      port: 18991,
      podmanSocket: inputFile('podman-socket'),
      network: 'test',
      workloadImage: 'sha256:a5a5302f2443c02f24506248883b9d22f070f58b288f898ac69a547b653e2161',
      sandboxRuntimeImage: `sha256:${digest}`,
      supervisorImage: `sha256:${digest}`,
      tls: {
        serverCert: inputFile('tls-server-cert'),
        serverKey: inputFile('tls-server-key'),
        clientCa: inputFile('tls-client-ca'),
        managementCert: inputFile('tls-management-cert'),
        managementKey: inputFile('tls-management-key'),
      },
      jwt: {
        signingKey: inputFile('jwt-signing-key'),
        publicKey: inputFile('jwt-public-key'),
        kid: inputFile('jwt-kid'),
      },
      upstreamProxy: {
        url: 'http://127.0.0.1:8118',
        caBundle: inputFile('upstream-ca'),
        caBundleSha256: digest,
      },
    },
    attestationPath: join(root, 'pending-attestation.json'),
    podman: {
      executable: inputFile('podman-executable'),
      environment: {
        HOME: join(root, 'podman'),
        PATH: '/usr/bin:/bin',
        XDG_CONFIG_HOME: join(root, 'podman-xdg'),
      },
      sandboxNamespace: 'test',
    },
    runtime: {
      seed: join(root, 'seed'),
      policy: inputFile('runtime-policy'),
      createDetached: true,
      sandboxIdLength: 13,
    },
    personal: {
      workProfiles: [
        {
          id: 'vertex',
          label: 'Vertex',
          provider: 'anthropic-vertex',
          credentialRef: inputFile('vertex-reference'),
          expectedPrincipal: 'synthetic@example.com',
          projectId: 'synthetic-project',
          region: 'global',
          models: [{ id: 'claude-haiku-4-5@20251001', label: 'Synthetic fixture only' }],
        },
      ],
      accountId: 'synthetic',
      label: 'Synthetic',
      selectedModel: 'luna',
      models: [{ id: 'luna', label: 'Luna' }],
    },
    artifacts: [],
    providerProfiles: [{ path: inputFile('provider-profile'), sha256: digest }],
  };
  mkdirSync(config.podman.environment.XDG_CONFIG_HOME, { mode: 0o700 });
  writeFileSync(plan.configPath, JSON.stringify(config), { mode: 0o600 });
  mkdirSync(stateParent, { mode: 0o700 });
  const gatewayStateDirectory = join(stateParent, 'gateway');
  mkdirSync(gatewayStateDirectory, { mode: 0o700 });
  return { root, plan, registration, stateParent, gatewayStateDirectory, config };
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

it.each([false, true])(
  'reconciles original retirement generation when hello has not occurred (previous ready: %s)',
  async (previousReady) => {
    const f = fixture();
    const generation = previousReady ? 2 : 1;
    await launchStagingCustodian(f.plan, f.registration, {
      verify() {},
      claim() {},
      async run(hooks) {
        if (previousReady)
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
            async retireRuntimes() {},
            async drainHost() {},
            async closeHost() {},
            record() {
              writeCustodianRetirementReceipt({
                stateParent: f.stateParent,
                gatewayStateDirectory: f.gatewayStateDirectory,
                instanceId: 'original',
                controllerGeneration: generation,
              });
            },
          },
          new AbortController().signal,
          (state) =>
            hooks.observeRetirement!(state, f.stateParent, {
              instanceId: 'original',
              controllerGeneration: generation,
            }),
        );
      },
    });
    const r = openStagingRegistry(f.registration.registryDirectory, 1);
    expect(r.list()[0]).toMatchObject({
      state: 'retired',
      instanceId: 'original',
      controllerGeneration: generation,
    });
    r.reserve({
      ownerChat: 'chat-2',
      purpose: 'next',
      retentionReason: 'next',
      reviewAfter: Date.now() + 60000,
      planDirectory: join(f.root, 'next'),
      sourceCommit: f.plan.sourceCommit,
      buildSha256: f.plan.buildSha256,
      configSha256: f.plan.configSha256,
    });
    r.close();
  },
);

it.each([
  'runtime-policy',
  'provider-profile',
  'tls-server-cert',
  'tls-server-key',
  'tls-client-ca',
  'tls-management-cert',
  'tls-management-key',
  'jwt-signing-key',
  'jwt-public-key',
  'jwt-kid',
  'gateway-executable',
  'gateway-cli',
  'system-ca',
  'upstream-ca',
  'vertex-reference',
  'podman-executable',
  'podman-socket',
  'podman-xdg',
])('rejects registry containing configured %s input without any side effects', async (input) => {
  const f = fixture();
  const registryDirectory = join(f.root, input);
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
it('rejects a registry containing the canonical target of a configured input alias', async () => {
  const f = fixture();
  const registryDirectory = join(f.root, 'aliased-input');
  mkdirSync(registryDirectory, { mode: 0o700 });
  const target = join(registryDirectory, 'policy');
  writeFileSync(target, 'synthetic', { mode: 0o600 });
  const alias = join(f.root, 'policy-alias');
  symlinkSync(target, alias);
  f.config.runtime.policy = alias;
  writeFileSync(f.plan.configPath, JSON.stringify(f.config), { mode: 0o600 });
  const claim = vi.fn();
  await expect(
    launchStagingCustodian(
      f.plan,
      { ...f.registration, registryDirectory },
      { verify() {}, claim, async run() {} },
    ),
  ).rejects.toThrow('overlap');
  expect(claim).not.toHaveBeenCalled();
  expect(existsSync(join(registryDirectory, 'staging.db'))).toBe(false);
  expect(readFileSync(target, 'utf8')).toBe('synthetic');
});
it('rejects a registry containing the future attestation target', async () => {
  const f = fixture();
  const directory = join(f.root, 'future-attestation');
  mkdirSync(directory, { mode: 0o700 });
  f.config.attestationPath = join(directory, 'not-created.json');
  writeFileSync(f.plan.configPath, JSON.stringify(f.config), { mode: 0o600 });
  const claim = vi.fn();
  await expect(
    launchStagingCustodian(
      f.plan,
      { ...f.registration, registryDirectory: directory },
      { verify() {}, claim, async run() {} },
    ),
  ).rejects.toThrow('overlap');
  expect(claim).not.toHaveBeenCalled();
  expect(existsSync(join(directory, 'staging.db'))).toBe(false);
});

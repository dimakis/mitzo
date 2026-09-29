import { assertSymposiumAttestedClaudeProvider } from '../symposium-production-gate.js';
import { collectOwnedAdmissionEvidence } from '../symposium-owned-evidence.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  digestSymposiumSeedTree,
  TESTED_SYMPOSIUM_NATIVE_BUILD as build,
  verifySymposiumProductionGate,
  type SymposiumProductionAttestation,
  type SymposiumProductionPhysicalProof,
} from '../symposium-production-gate.js';
import type { OpenShellRuntimeConfig } from '../openshell-runtime.js';

// A fixture byte stream stands in for the large reviewed upstream binary. All
// production hashing remains real; only this test's exact CLI bytes are mocked.
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return {
    ...actual,
    createHash: (algorithm: string) => {
      const parts: Buffer[] = [];
      return {
        update(value: string | Buffer) {
          parts.push(Buffer.from(value));
          return this;
        },
        digest(format: 'hex') {
          const bytes = Buffer.concat(parts);
          return bytes.toString() === 'owned-native-test-cli'
            ? '5a02cb78ef641da6badec1901677d4478c059a0080dbf4de13a6bbc503588dc8'
            : actual.createHash(algorithm).update(bytes).digest(format);
        },
      };
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'symposium-native-gate-'));
  roots.push(root);
  const cli = join(root, 'cli'),
    policy = join(root, 'policy'),
    seed = join(root, 'seed');
  writeFileSync(cli, 'owned-native-test-cli');
  writeFileSync(policy, 'policy');
  mkdirSync(seed);
  const config: OpenShellRuntimeConfig = {
    cli,
    policy,
    seed,
    image: build.image,
    gateway: 'owned',
    workspace: 'symposium',
    gatewayInsecure: false,
    cliEnvironment: { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), PATH: '/usr/bin:/bin' },
    serviceProviders: [],
    grantableServiceProviders: [],
    createDetached: true,
    sandboxIdLength: 13,
    workdir: '/sandbox/workspaces/mgmt',
    webSearch: 'disabled',
  };
  const attestation: Extract<
    SymposiumProductionAttestation,
    { contract: 'openshell-v0.1-owned-native-seats' }
  > = {
    contract: 'openshell-v0.1-owned-native-seats',
    cliVersion: build.version,
    cliSha256: build.cliSha256,
    gatewayVersion: build.version,
    gatewaySha256: build.gatewaySha256,
    gateway: config.gateway,
    workspace: config.workspace,
    gatewayEndpoint: 'https://127.0.0.1:18791',
    image: build.image,
    imageDigest: build.imageDigest,
    controllerPath: '/usr/bin/codex',
    controllerSha256: build.nativeArtifacts['/usr/bin/codex'],
    policySha256: hash('policy'),
    seedTreeSha256: digestSymposiumSeedTree(seed),
    sandboxRuntimeImage: build.sandboxRuntimeImage,
    supervisorImage: build.supervisorImage,
    nativeArtifacts: { ...build.nativeArtifacts },
    providerProfiles: [
      { name: 'openai', sha256: hash('openai') },
      { name: 'codex', sha256: hash('codex') },
    ],
    providerInstances: [
      { name: 'work', id: 'work-id', type: 'openai', profileName: 'openai' },
      { name: 'personal', id: 'personal-id', type: 'codex', profileName: 'codex' },
    ],
    artifactVolume: { driver: 'podman', name: 'artifacts' },
    allowedRoles: ['implementer', 'coder', 'reviewer'],
    allowedAccountProviders: ['openai', 'openai-codex'],
  };
  const physical: SymposiumProductionPhysicalProof = {
    verifyOwnedNativeHost: vi.fn(),
    verifyNativeArtifacts: vi.fn(),
    verifyImageAndController: vi.fn(),
    verifyProviderProfile: vi.fn(),
    verifyProviderInstance: vi.fn(),
    verifyGatewayDriverConfig: vi.fn(),
    verifyArtifactVolume: vi.fn(),
  };
  const invoke = vi.fn((_cli: string, args: string[]) =>
    args[0] === '--version'
      ? `openshell ${build.version}`
      : JSON.stringify({
          gateway: config.gateway,
          server: attestation.gatewayEndpoint,
          version: build.version,
          status: 'healthy',
          compute_drivers: [{ name: 'podman', capabilities: { driver_version: build.version } }],
        }),
  );
  return { config, attestation, physical, invoke };
}
describe('owned native admission contract', () => {
  it('collects a candidate through the actual gate and refuses contradictory physical evidence', () => {
    const f = fixture();
    const custody = vi.fn();
    const host = {
      config: f.config,
      endpoint: f.attestation.gatewayEndpoint,
      physical: f.physical,
      custody,
    };
    const selection = {
      providerInstances: f.attestation.providerInstances,
      allowedRoles: f.attestation.allowedRoles,
      allowedAccountProviders: f.attestation.allowedAccountProviders,
      artifactVolume: f.attestation.artifactVolume,
    };
    const invoke = (cli: string, args: string[]) =>
      args[0] === 'profile'
        ? JSON.stringify({ id: args[2], provider: args[2] })
        : f.invoke(cli, args);
    const candidate = collectOwnedAdmissionEvidence(host, selection, { invoke });
    expect(candidate.providerInstances).toEqual(selection.providerInstances);
    expect(f.physical.verifyArtifactVolume).toHaveBeenCalled();
    expect(f.physical.verifyProviderInstance).toHaveBeenCalledTimes(2);
    expect(f.physical.verifyOwnedNativeHost).toHaveBeenCalledTimes(2);
    expect(custody).toHaveBeenCalledTimes(2);
    vi.mocked(f.physical.verifyArtifactVolume).mockImplementation(() => {
      throw new Error('volume drift');
    });
    expect(() => collectOwnedAdmissionEvidence(host, selection, { invoke })).toThrow(
      'volume drift',
    );
  });

  it('requires live owned custody plus every reviewed artifact before reviewer and personal capability', () => {
    const f = fixture();
    const result = verifySymposiumProductionGate(f.config, f.attestation, f.physical, f.invoke);
    expect(result.readOnlyEnforced).toBe(true);
    expect([...result.allowedRoles]).toContain('reviewer');
    expect([...result.allowedAccountProviders]).toEqual(['openai', 'openai-codex']);
    expect(f.physical.verifyNativeArtifacts).toHaveBeenCalledWith(
      build.image,
      build.imageDigest,
      build.nativeArtifacts,
    );
    expect(f.physical.verifyOwnedNativeHost).toHaveBeenCalledTimes(2);
    expect(f.physical.verifyOwnedNativeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        cli: f.config.cli,
        cliEnvironment: f.config.cliEnvironment,
        gatewaySha256: build.gatewaySha256,
        supervisorImage: build.supervisorImage,
      }),
    );
  });
  it.each(['verifyOwnedNativeHost', 'verifyNativeArtifacts'] as const)(
    'rejects missing %s',
    (key) => {
      const f = fixture();
      delete f.physical[key];
      expect(() =>
        verifySymposiumProductionGate(f.config, f.attestation, f.physical, f.invoke),
      ).toThrow(/proof is unavailable/);
      expect(f.invoke).not.toHaveBeenCalled();
    },
  );
  it.each([
    'cliSha256',
    'gatewaySha256',
    'cliVersion',
    'gatewayVersion',
    'supervisorImage',
    'sandboxRuntimeImage',
    'image',
  ] as const)('rejects unreviewed %s', (key) => {
    const f = fixture();
    const value = { ...f.attestation, [key]: 'unreviewed' };
    expect(() =>
      verifySymposiumProductionGate(
        f.config,
        value as SymposiumProductionAttestation,
        f.physical,
        f.invoke,
      ),
    ).toThrow();
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('rejects native bytes that differ from reviewed canaries and missing artifacts', () => {
    for (const missing of [false, true]) {
      const f = fixture();
      const artifacts: Record<string, string> = { ...f.attestation.nativeArtifacts };
      if (missing) delete artifacts['/usr/local/bin/symposium-seat-landlock'];
      else artifacts['/usr/local/bin/symposium-seat-landlock'] = '0'.repeat(64);
      expect(() =>
        verifySymposiumProductionGate(
          f.config,
          { ...f.attestation, nativeArtifacts: artifacts } as SymposiumProductionAttestation,
          f.physical,
          f.invoke,
        ),
      ).toThrow();
    }
  });
  it('rejects actual physical artifact drift and custody lost during verification', () => {
    const f = fixture();
    vi.mocked(f.physical.verifyNativeArtifacts!).mockImplementation(() => {
      throw new Error('native bytes changed');
    });
    expect(() =>
      verifySymposiumProductionGate(f.config, f.attestation, f.physical, f.invoke),
    ).toThrow('native bytes changed');
    const g = fixture();
    vi.mocked(g.physical.verifyOwnedNativeHost!)
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error('custody lost');
      });
    expect(() =>
      verifySymposiumProductionGate(g.config, g.attestation, g.physical, g.invoke),
    ).toThrow('custody lost');
  });
  it('rejects missing codex instance, unowned route, and capability extensions', () => {
    const f = fixture();
    f.attestation.providerInstances = f.attestation.providerInstances.filter(
      (p) => p.type !== 'codex',
    );
    expect(() =>
      verifySymposiumProductionGate(f.config, f.attestation, f.physical, f.invoke),
    ).toThrow(/lacks an attested/);
    const g = fixture();
    delete g.config.cliEnvironment;
    expect(() =>
      verifySymposiumProductionGate(g.config, g.attestation, g.physical, g.invoke),
    ).toThrow(/unavailable/);
    const h = fixture();
    expect(() =>
      verifySymposiumProductionGate(
        h.config,
        {
          ...h.attestation,
          allowedAccountProviders: ['anthropic-vertex'],
        } as unknown as SymposiumProductionAttestation,
        h.physical,
        h.invoke,
      ),
    ).toThrow();
  });
});

const measuredCanonicalBuild = {
  image: 'sha256:a5a5302f2443c02f24506248883b9d22f070f58b288f898ac69a547b653e2161',
  imageDigest: '55b6dc5c7aaf443c4a11c44d29a170697648e63f3b8f81f7e1e93b7535e9fe17',
  controllerSha256: '4d76e542c222ea8c75861d8c4ade60a1a332a63255ce1c60bdaebf7c2a2869e6',
};
it('accepts measured canonical build only through the remaining custody and policy checks', () => {
  const f = fixture();
  f.config.image = measuredCanonicalBuild.image;
  const attestation = {
    ...f.attestation,
    ...measuredCanonicalBuild,
    nativeArtifacts: {
      ...f.attestation.nativeArtifacts,
      '/usr/bin/codex': measuredCanonicalBuild.controllerSha256,
      '/usr/local/bin/symposium-seat-landlock':
        '286c37e476c145df22216402310b20ac7a7ac735d6280a1293b800299b76801f',
    },
  } as SymposiumProductionAttestation;
  expect(
    verifySymposiumProductionGate(f.config, attestation, f.physical, f.invoke).readOnlyEnforced,
  ).toBe(true);
  expect(f.physical.verifyNativeArtifacts).toHaveBeenCalledWith(
    measuredCanonicalBuild.image,
    measuredCanonicalBuild.imageDigest,
    expect.objectContaining({ '/usr/bin/codex': measuredCanonicalBuild.controllerSha256 }),
  );
  vi.mocked(f.physical.verifyOwnedNativeHost!).mockImplementation(() => {
    throw new Error('custody denied');
  });
  expect(() => verifySymposiumProductionGate(f.config, attestation, f.physical, f.invoke)).toThrow(
    'custody denied',
  );
  vi.mocked(f.physical.verifyOwnedNativeHost!).mockImplementation(() => {});
  writeFileSync(f.config.policy, 'changed policy');
  expect(() => verifySymposiumProductionGate(f.config, attestation, f.physical, f.invoke)).toThrow(
    'policy or seed digest changed',
  );
});
it('rejects the former wrapper image and hash even with otherwise valid host proof', () => {
  const f = fixture();
  const prior = {
    ...f.attestation,
    image: 'sha256:c621f4a66281689c9d4c2692ca7234ba61cd154f58c3df003a193f58375bb63d',
    imageDigest: 'd00a366614f1926d7159a5290818418b041167295ba2e93692ce47a38e06448f',
    controllerSha256: '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70',
    nativeArtifacts: {
      ...f.attestation.nativeArtifacts,
      '/usr/bin/codex': '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70',
      '/usr/local/bin/symposium-seat-landlock':
        'bf31950c31eafab27d54ddd3662e450769811ea906687616217d743d3134c96d',
    },
  } as SymposiumProductionAttestation;
  f.config.image = prior.image;
  expect(() => verifySymposiumProductionGate(f.config, prior, f.physical, f.invoke)).toThrow();
  expect(f.invoke).not.toHaveBeenCalled();
});
it.each(['controllerSha256', 'imageDigest'] as const)('rejects wrong measured %s', (key) => {
  const f = fixture();
  expect(() =>
    verifySymposiumProductionGate(
      f.config,
      { ...f.attestation, [key]: '0'.repeat(64) } as SymposiumProductionAttestation,
      f.physical,
      f.invoke,
    ),
  ).toThrow();
  expect(f.invoke).not.toHaveBeenCalled();
});

import {
  REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME,
  REVIEWED_SYMPOSIUM_CODE_MODE_RUNTIME,
} from '../symposium-owned-runtime-contract.js';

it('requires the exact code-mode host in the separately reviewed successor image', () => {
  const f = fixture();
  const successor = REVIEWED_SYMPOSIUM_CODE_MODE_RUNTIME.build;
  f.config.image = successor.image;
  const attestation = {
    ...f.attestation,
    image: successor.image,
    imageDigest: successor.imageDigest,
    controllerSha256: successor.nativeArtifacts['/usr/bin/codex'],
    nativeArtifacts: { ...successor.nativeArtifacts },
  } as SymposiumProductionAttestation;
  expect(
    verifySymposiumProductionGate(f.config, attestation, f.physical, f.invoke).readOnlyEnforced,
  ).toBe(true);
  expect(f.physical.verifyNativeArtifacts).toHaveBeenCalledWith(
    successor.image,
    successor.imageDigest,
    successor.nativeArtifacts,
  );
  for (const artifacts of [
    { ...successor.nativeArtifacts, '/usr/bin/codex-code-mode-host': '0'.repeat(64) },
    Object.fromEntries(
      Object.entries(successor.nativeArtifacts).filter(
        ([path]) => path !== '/usr/bin/codex-code-mode-host',
      ),
    ),
  ]) {
    expect(() =>
      verifySymposiumProductionGate(
        f.config,
        { ...attestation, nativeArtifacts: artifacts } as SymposiumProductionAttestation,
        f.physical,
        f.invoke,
      ),
    ).toThrow();
  }
  expect(() =>
    verifySymposiumProductionGate(
      f.config,
      {
        ...attestation,
        controllerSha256: REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME.build.nativeArtifacts['/usr/bin/codex'],
      },
      f.physical,
      f.invoke,
    ),
  ).toThrow();
});
import { symposiumArtifactOwner } from '../symposium-artifact-owner.js';
const vertexReceipt = {
  principal: 'work@example.test',
  accountId: 'vertex-work',
  provider: 'vertex-work',
  providerId: 'vertex-id',
  projectId: 'project-1',
  region: 'global' as const,
  model: 'claude-haiku-4-5@20251001' as const,
  workspace: 'symposium',
};
function claudeFixture() {
  const f = fixture();
  const claude = REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME.build;
  f.config.image = claude.image;
  Object.assign(f.attestation, {
    image: claude.image,
    imageDigest: claude.imageDigest,
    nativeArtifacts: claude.nativeArtifacts,
  });
  f.attestation.providerProfiles.push({ name: 'google-vertex-ai', sha256: hash('vertex') });
  f.attestation.providerInstances.push({
    name: 'vertex-work',
    id: 'vertex-id',
    type: 'google-vertex-ai',
    profileName: 'google-vertex-ai',
  });
  f.attestation.allowedAccountProviders.push('anthropic-vertex');
  f.physical.captureClaudeProvider = vi.fn(() => vertexReceipt);
  return f;
}
it('admits the separate measured Claude variant only with live retained selected-provider proof', () => {
  const f = claudeFixture();
  const verified = verifySymposiumProductionGate(f.config, f.attestation, f.physical, f.invoke);
  expect(verified.claudeProviders.get('vertex-work')).toEqual(vertexReceipt);
  expect(() => assertSymposiumAttestedClaudeProvider(verified, vertexReceipt)).not.toThrow();
  for (const field of [
    'accountId',
    'provider',
    'providerId',
    'projectId',
    'region',
    'model',
    'workspace',
  ] as const)
    expect(() =>
      assertSymposiumAttestedClaudeProvider(verified, { ...vertexReceipt, [field]: 'drift' }),
    ).toThrow();
  expect(f.physical.captureClaudeProvider).toHaveBeenCalledWith('vertex-id');
  expect(f.physical.verifyNativeArtifacts).toHaveBeenCalledWith(
    f.config.image,
    f.attestation.imageDigest,
    REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME.build.nativeArtifacts,
  );
  expect(symposiumArtifactOwner(f.config.image)).toEqual({
    image: f.config.image,
    uid: 998,
    gid: 998,
  });
  const old = fixture();
  expect(
    verifySymposiumProductionGate(old.config, old.attestation, old.physical, old.invoke)
      .claudeProviders.size,
  ).toBe(0);
});
it.each(['missing', 'changed-provider', 'changed-workspace', 'lost-custody'] as const)(
  'rejects Claude capability with %s',
  (failure) => {
    const f = claudeFixture();
    if (failure === 'missing') delete f.physical.captureClaudeProvider;
    if (failure === 'changed-provider')
      f.physical.captureClaudeProvider = () => ({ ...vertexReceipt, providerId: 'other' });
    if (failure === 'changed-workspace')
      f.physical.captureClaudeProvider = () => ({ ...vertexReceipt, workspace: 'other' });
    if (failure === 'lost-custody')
      f.physical.captureClaudeProvider = () => {
        throw Error('custody unavailable');
      };
    expect(() =>
      verifySymposiumProductionGate(f.config, f.attestation, f.physical, f.invoke),
    ).toThrow();
  },
);
it('rejects mixing old image with new helper hashes or adding Vertex to old image', () => {
  for (const patch of [
    { image: build.image, imageDigest: build.imageDigest },
    { nativeArtifacts: build.nativeArtifacts },
  ]) {
    const f = claudeFixture();
    Object.assign(f.attestation, patch);
    f.config.image = f.attestation.image;
    expect(() =>
      verifySymposiumProductionGate(f.config, f.attestation, f.physical, f.invoke),
    ).toThrow();
  }
});
it('collects Claude image evidence from selected owned host and requires the existing live receipt', () => {
  const f = claudeFixture();
  const selection = {
    providerInstances: f.attestation.providerInstances,
    allowedRoles: f.attestation.allowedRoles,
    allowedAccountProviders: f.attestation.allowedAccountProviders,
    artifactVolume: f.attestation.artifactVolume,
  };
  const invoke = (cli: string, args: string[]) =>
    args[0] === 'profile'
      ? JSON.stringify({ id: args[2], provider: args[2] })
      : f.invoke(cli, args);
  const candidate = collectOwnedAdmissionEvidence(
    {
      config: f.config,
      endpoint: f.attestation.gatewayEndpoint,
      physical: f.physical,
      custody: vi.fn(),
    },
    selection,
    { invoke },
  );
  expect(candidate.image).toBe(REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME.build.image);
  if (candidate.contract !== 'openshell-v0.1-owned-native-seats')
    throw new Error('Expected owned candidate');
  expect(candidate.nativeArtifacts).toEqual(
    REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME.build.nativeArtifacts,
  );
  expect(f.physical.captureClaudeProvider).toHaveBeenCalledWith('vertex-id');
});

import { createOwnedSeatPolicySelector } from '../symposium-owned-seat-policy.js';
import { AccountProfiles } from '../account-profiles.js';
import { chmodSync, readFileSync } from 'node:fs';
it('keeps the collected base-policy hash distinct from the exact derived Vertex seat policy', () => {
  const f = claudeFixture();
  const base = JSON.stringify({
    version: 1,
    filesystem_policy: { include_workdir: true, read_only: ['/usr'], read_write: ['/sandbox'] },
    landlock: { compatibility: 'best_effort' },
    network_policies: { codex: { endpoints: [{ host: 'chatgpt.com' }] } },
  });
  writeFileSync(f.config.policy, base);
  const candidate = collectOwnedAdmissionEvidence(
    {
      config: f.config,
      endpoint: f.attestation.gatewayEndpoint,
      physical: f.physical,
      custody: () => {},
    },
    {
      providerInstances: f.attestation.providerInstances,
      allowedRoles: f.attestation.allowedRoles,
      allowedAccountProviders: f.attestation.allowedAccountProviders,
      artifactVolume: f.attestation.artifactVolume,
    },
    {
      invoke: (cli, args) =>
        args[0] === 'profile'
          ? JSON.stringify({ id: args[2], provider: args[2] })
          : f.invoke(cli, args),
    },
  );
  const profiles = new AccountProfiles([
    {
      id: vertexReceipt.accountId,
      label: 'Work',
      provider: 'anthropic-vertex',
      credentialRef: '/never-read-adc',
      projectId: vertexReceipt.projectId,
      region: 'global',
      sandboxProvider: vertexReceipt.provider,
      sandboxProviderId: vertexReceipt.providerId,
      models: [{ id: vertexReceipt.model, label: 'Haiku' }],
    },
  ]);
  const binding = profiles.resolve(vertexReceipt.accountId, vertexReceipt.model);
  const selector = createOwnedSeatPolicySelector({
    gateway: {
      stateDirectory: join(f.config.seed, '..'),
      workspace: 'symposium',
      verifyCustody: () => {},
    } as never,
    basePolicy: f.config.policy,
    baseDigest: candidate.policySha256,
    facts: {
      getActiveSymposiumConfig: () => ({
        version: 2,
        state: 'active',
        seats: [{ id: 'seat', accountBinding: binding }],
      }),
      getLatestSymposiumMembership: () => ({ state: 'active', generation: 1 }),
    } as never,
    currentProfiles: () => profiles,
    hostGrants: { verifySeat: () => {} },
    capture: () => vertexReceipt,
  });
  const selected = selector({ sessionId: 'session', seatId: 'seat', generation: 1 })!;
  expect(candidate.policySha256).toBe(hash(base));
  expect(selected.sha256).not.toBe(candidate.policySha256);
  expect(readFileSync(selected.path, 'utf8')).not.toContain('chatgpt.com');
  selected.verify();
  const capability = verifySymposiumProductionGate(f.config, candidate, f.physical, f.invoke);
  expect(capability.runtimeConfig.policy).toBe(f.config.policy);
  chmodSync(selected.path, 0o600);
  writeFileSync(selected.path, '{}');
  chmodSync(selected.path, 0o400);
  // Base attestation alone never authorizes the mutated effective seat policy.
  expect(() => selected.verify()).toThrow();
});

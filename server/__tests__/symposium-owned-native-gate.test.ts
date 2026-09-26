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

import { readSymposiumProductionAttestation } from '../symposium-production-gate.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createOwnedSymposiumHost,
  type OwnedSymposiumHostOptions,
} from '../symposium-owned-host.js';
import type { OwnedSymposiumGateway } from '../symposium-owned-gateway.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'symposium-owned-host-test-'));
  roots.push(root);
  const attestation = join(root, 'attestation.json');
  writeFileSync(attestation, '{}', { mode: 0o600 });
  const gateway = {
    cli: '/private/owned/openshell',
    gateway: 'owned',
    workspace: 'workspace',
    endpoint: 'https://127.0.0.1:12345',
    stateDirectory: root,
    managementEnvironment: { HOME: root, XDG_CONFIG_HOME: root, PATH: '/usr/bin:/bin' },
    verifyCustody: vi.fn(),
    stop: vi.fn(),
    verifyGatewayDriverConfig: vi.fn(),
  };
  const seat = {
    id: 'seat',
    role: 'implementer',
    authorityGrant: { filesystem: 'write', tools: 'write' },
  };
  const membership = { state: 'active', generation: 2 };
  const facts = {
    getActiveSymposiumConfig: () => ({ version: 2, state: 'active', seats: [seat] }),
    getLatestSymposiumMembership: () => membership,
    getSymposiumSeatSandbox: vi.fn(),
  };
  const options = {
    gateway: {
      gateway: 'owned',
      workspace: 'workspace',
      workloadImage: `sha256:${'a'.repeat(64)}`,
    },
    attestationPath: attestation,
    runtime: {
      policy: '/private/policy.yaml',
      seed: '/private/seed',
      createDetached: true,
      sandboxIdLength: 13,
    },
    podman: {
      executable: '/bin/podman',
      environment: { PATH: '/usr/bin:/bin' },
      sandboxNamespace: 'namespace',
    },
    personal: {
      workProfiles: [],
      accountId: 'personal',
      label: 'Personal',
      selectedModel: 'luna',
      models: [{ id: 'luna', label: 'Luna' }],
    },
    facts,
    hostGrants: { verifySeat: vi.fn() },
    artifacts: [{ sessionId: 'session', volumeName: 'artifacts', volumeGeneration: 'generation' }],
  } as unknown as OwnedSymposiumHostOptions;
  const launch = vi.fn().mockResolvedValue(gateway as unknown as OwnedSymposiumGateway);
  return { root, gateway, options, launch, seat, membership };
}
describe('explicit owned Symposium host composition', () => {
  it('composes isolated private registries and named gateway without admission or login side effects', async () => {
    const f = fixture();
    const host = await createOwnedSymposiumHost(f.options, f.launch);
    expect(host.runtimeConfig.gateway).toBe('owned');
    expect(host.runtimeConfig.gatewayEndpoint).toBeUndefined();
    expect(host.runtimeConfig.cliEnvironment).toEqual(f.gateway.managementEnvironment);
    expect(host.runtimeConfig.cliContract).toBeUndefined();
    expect(host.runtimeConfig.serviceProviders).toEqual([]);
    expect(host.currentProfiles().catalog()).toEqual([]);
    expect(statSync(join(f.root, 'artifact-leases.db')).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.root, 'native-attempts', 'claims.db')).mode & 0o777).toBe(0o600);
    expect(host.attestationPath).toBe(f.options.attestationPath);
    host.stop();
    host.stop();
    expect(f.gateway.stop).toHaveBeenCalledOnce();
    expect(() => host.currentProfiles()).toThrow('stopped');
  });
  it('derives artifact access from current host seat authority and generation', async () => {
    const f = fixture();
    const host = await createOwnedSymposiumHost(f.options, f.launch);
    expect(host.artifactRequest('session', 'seat', 2)).toMatchObject({
      access: 'writer',
      driver: 'podman',
      workspaceId: 'workspace',
      volumeName: 'artifacts',
    });
    f.seat.role = 'reviewer';
    expect(host.artifactRequest('session', 'seat', 2).access).toBe('reviewer');
    expect(() => host.artifactRequest('unknown', 'seat', 2)).toThrow('mapping');
    f.membership.generation = 3;
    expect(() => host.artifactRequest('session', 'seat', 2)).toThrow('mapping');
    host.stop();
  });
  it('allows setup with pending evidence without fabricating a file or opening admission', async () => {
    const f = fixture();
    f.options.attestationPath = join(f.root, 'pending.json');
    const host = await createOwnedSymposiumHost(f.options, f.launch);
    expect(host.attestationPath).toBe(f.options.attestationPath);
    expect(existsSync(host.attestationPath)).toBe(false);
    expect(host.currentProfiles().catalog()).toEqual([]);
    expect(() => readSymposiumProductionAttestation(host.attestationPath)).toThrow();
    expect(host.runtimeConfig.cliContract).toBeUndefined();
    host.stop();
  });
  it('rejects an existing public attestation before launching a gateway', async () => {
    const f = fixture();
    chmodSync(f.options.attestationPath, 0o644);
    await expect(createOwnedSymposiumHost(f.options, f.launch)).rejects.toThrow('private regular');
    expect(f.launch).not.toHaveBeenCalled();
  });
  it('stops only newly owned gateway if downstream composition fails', async () => {
    const f = fixture();
    f.options.personal.selectedModel = 'unconfigured';
    await expect(createOwnedSymposiumHost(f.options, f.launch)).rejects.toThrow(
      'explicit available',
    );
    expect(f.gateway.stop).toHaveBeenCalledOnce();
  });
});

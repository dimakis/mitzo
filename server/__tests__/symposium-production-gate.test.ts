import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readSymposiumProductionAttestation,
  digestSymposiumSeedTree,
  verifySymposiumProductionGate,
  type SymposiumProductionPhysicalProof,
} from '../symposium-production-gate.js';
import type { OpenShellRuntimeConfig } from '../openshell-runtime.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'symposium-gate-'));
  directories.push(directory);
  const policy = join(directory, 'policy.yaml');
  const seed = join(directory, 'seed');
  const cli = join(directory, 'openshell');
  writeFileSync(policy, 'policy');
  mkdirSync(seed);
  mkdirSync(join(seed, 'nested'));
  writeFileSync(join(seed, 'nested', 'context.txt'), 'seed');
  writeFileSync(cli, 'cli');
  const config: OpenShellRuntimeConfig = {
    cli, image: 'mitzo@sha256:image', policy, seed,
    serviceProviders: [], grantableServiceProviders: [], workspace: 'symposium',
    gateway: 'private-gateway', gatewayInsecure: false, createDetached: true,
    sandboxIdLength: 13, workdir: '/sandbox/workspaces/mgmt', webSearch: 'disabled',
  };
  const attestation = {
    contract: 'openshell-v0.1-openai-seat' as const,
    cliVersion: '0.1.0', cliSha256: sha('cli'), gatewayVersion: '0.1.0', gateway: 'private-gateway',
    workspace: 'symposium', image: config.image, imageDigest: sha('image'),
    policySha256: sha('policy'), seedTreeSha256: digestSymposiumSeedTree(seed), controllerPath: '/usr/bin/codex' as const,
    controllerSha256: sha('codex'),
    providerProfiles: [{ name: 'openai', sha256: sha('profile') }],
    artifactVolume: { driver: 'podman' as const, name: 'symposium-artifacts' },
    allowedRoles: ['implementer' as const, 'coder' as const],
    allowedAccountProviders: ['openai'] as ['openai'],
  };
  const physical: SymposiumProductionPhysicalProof = {
    verifyImageAndController: vi.fn(), verifyProviderProfile: vi.fn(),
    verifyGatewayDriverConfig: vi.fn(), verifyArtifactVolume: vi.fn(),
  };
  const invoke = vi.fn((_cli: string, args: string[]) =>
    args[0] === '--version' ? 'openshell 0.1.0' : JSON.stringify({
      gateway: 'private-gateway', version: '0.1.0', status: 'healthy', compute_drivers: [
        { name: 'podman', capabilities: { driver_version: '0.1.0' } },
      ],
    }));
  return { directory, config, attestation, physical, invoke };
}

describe('Symposium production gate', () => {
  it('requires private host attestation with exact reviewed shape', () => {
    const { directory, attestation } = setup();
    const path = join(directory, 'attestation.json');
    writeFileSync(path, JSON.stringify(attestation), { mode: 0o600 });
    expect(readSymposiumProductionAttestation(path)).toEqual(attestation);
    chmodSync(path, 0o644);
    expect(() => readSymposiumProductionAttestation(path)).toThrow('private host file');
  });

  it('enables only explicit writer roles after live selected gateway and physical proofs', () => {
    const { config, attestation, physical, invoke } = setup();
    const result = verifySymposiumProductionGate(config, attestation, physical, invoke);
    expect(result.runtimeConfig.cliContract).toBe('v0.1');
    expect([...result.allowedRoles]).toEqual(['implementer', 'coder']);
    expect([...result.attestedProviderProfiles]).toEqual(['openai']);
    expect(invoke).toHaveBeenCalledWith(config.cli, [
      'gateway', 'info', '--gateway', 'private-gateway', '--workspace', 'symposium', '--output', 'json',
    ]);
    expect(physical.verifyProviderProfile).toHaveBeenCalledWith('openai', sha('profile'), 'symposium');
    expect(physical.verifyArtifactVolume).toHaveBeenCalledWith('podman', 'symposium-artifacts', 'symposium');
  });

  it('fails closed without physical proof or on changed policy, gateway, or reviewer role', () => {
    const { config, attestation, physical, invoke } = setup();
    expect(() => verifySymposiumProductionGate(config, attestation, undefined, invoke)).toThrow('proof is unavailable');
    expect(() => verifySymposiumProductionGate(config, { ...attestation, policySha256: sha('other') }, physical, invoke)).toThrow('digest changed');
    expect(() => verifySymposiumProductionGate(config, { ...attestation, allowedRoles: ['reviewer'] } as never, physical, invoke)).toThrow();
    expect(() => verifySymposiumProductionGate(config, { ...attestation, allowedAccountProviders: ['anthropic-vertex'] } as never, physical, invoke)).toThrow();
    const wrongGateway = vi.fn((_cli: string, args: string[]) =>
      args[0] === '--version' ? 'openshell 0.1.0' : JSON.stringify({ gateway: 'private-gateway', version: '0.0.116', status: 'healthy', compute_drivers: [] }));
    expect(() => verifySymposiumProductionGate(config, attestation, physical, wrongGateway)).toThrow('gateway or compute driver changed');
    expect(physical.verifyArtifactVolume).not.toHaveBeenCalled();
  });

  it('rejects ambiguous provider profile names before any physical probe', () => {
    const { config, attestation, physical, invoke } = setup();
    const duplicate = {
      ...attestation,
      providerProfiles: [...attestation.providerProfiles, { name: 'openai', sha256: sha('other') }],
    };
    expect(() => verifySymposiumProductionGate(config, duplicate, physical, invoke)).toThrow('must be unique');
    expect(physical.verifyProviderProfile).not.toHaveBeenCalled();
  });

  it('digests the complete seed tree and rejects links', () => {
    const { config, attestation, physical, invoke } = setup();
    writeFileSync(join(config.seed, 'nested', 'context.txt'), 'changed');
    expect(() => verifySymposiumProductionGate(config, attestation, physical, invoke)).toThrow('digest changed');
    symlinkSync(join(config.seed, 'nested'), join(config.seed, 'alias'));
    expect(() => digestSymposiumSeedTree(config.seed)).toThrow('symbolic links');
  });
});

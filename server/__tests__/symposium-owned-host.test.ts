import * as personalHost from '../symposium-personal-host.js';
import * as discoveryHost from '../symposium-model-discovery-host.js';
import { SymposiumPerSeatSandboxOwner } from '../symposium-session-runtime.js';
import { sandboxNameForConversation } from '../openshell-runtime.js';
import { readSymposiumProductionAttestation } from '../symposium-production-gate.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createOwnedSymposiumHost,
  type OwnedSymposiumHostOptions,
} from '../symposium-owned-host.js';
import type { OwnedSymposiumGateway } from '../symposium-owned-gateway.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'symposium-owned-host-test-'));
  roots.push(root);
  const attestation = join(root, 'attestation.json');
  writeFileSync(attestation, '{}', { mode: 0o600 });
  writeFileSync(join(root, 'policy.yaml'), 'mock policy', { mode: 0o600 });
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
      stateParent: root,
      gateway: 'owned',
      workspace: 'workspace',
      workloadImage: `sha256:${'a'.repeat(64)}`,
    },
    attestationPath: attestation,
    runtime: {
      policy: join(root, 'policy.yaml'),
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
  it.each(['suspended', 'removed'])(
    'retains exact artifact cleanup identity after %s and role replacement',
    async (state) => {
      const f = fixture();
      const host = await createOwnedSymposiumHost(f.options, f.launch, undefined, async () => '[]');
      const sandboxName = sandboxNameForConversation('old-runtime', 13);
      const original = host.artifactRequest('session', 'seat', 2);
      const lease = await host.artifactLeaseHost.reserve(original);
      host.artifactLeaseHost.markCreationStarted(lease.token, lease.revision, sandboxName);
      host.artifactLeaseHost.bindSandbox(lease.token, lease.revision, sandboxName, 'physical-old');
      const record = {
        sessionId: 'session',
        seatId: 'seat',
        generation: 2,
        workspace: 'workspace',
        sandboxName: sandboxName,
        physicalId: 'physical-old',
        creationStarted: true,
        creationCompleted: true,
        runtimeId: 'old-runtime',
        providerName: 'old-provider',
        providerId: 'old-id',
        providerType: 'openai',
        model: 'luna',
        state: 'ready',
      };
      vi.mocked(f.options.facts.getSymposiumSeatSandbox).mockReturnValue(record as never);
      f.membership.state = state;
      f.membership.generation = 3;
      f.seat.role = 'reviewer';
      f.seat.authorityGrant.filesystem = 'none';
      expect(() => host.artifactRequest('session', 'seat', 2)).toThrow('mapping');
      expect(host.artifactRequest('session', 'seat', 2, 'cleanup')).toEqual(original);
      record.physicalId = 'replacement';
      expect(() => host.artifactRequest('session', 'seat', 2, 'cleanup')).toThrow();
      record.physicalId = 'physical-old';
      record.workspace = 'other';
      expect(() => host.artifactRequest('session', 'seat', 2, 'cleanup')).toThrow();
      record.workspace = 'workspace';
      let phase: 'Ready' | 'Stopped' | 'Absent' = 'Ready';
      const remove = vi.fn(async () => {
        phase = 'Absent';
      });
      const owner = new SymposiumPerSeatSandboxOwner({
        sessionId: 'session',
        runtimeConfig: { ...host.runtimeConfig, cliContract: 'v0.1' },
        readOnlyEnforced: { openaiApi: true, claudeVertex: false },
        perSeatSandboxVerified: true,
        artifactRequest: host.artifactRequest,
        artifactLeaseHost: host.artifactLeaseHost,
        seatSandboxRegistry: {
          claimSymposiumSeatLifecycle: () => true,
          releaseSymposiumSeatLifecycle: () => {},
          listUnstoppedSymposiumSeatSandboxes: () => (record.state === 'stopped' ? [] : [record]),
          confirmSymposiumSeatSandboxStopped: () => {
            record.state = 'stopped';
          },
        },
        managerFactory: () => ({
          inspect: async () => (phase === 'Absent' ? undefined : { id: record.physicalId, phase }),
          inspectReserved: async () =>
            phase === 'Absent' ? undefined : { id: record.physicalId, name: sandboxName, phase },
          stop: async () => {
            phase = 'Stopped';
          },
          delete: remove,
        }),
      } as never);
      await owner.stop('session', 'seat', 3, new AbortController().signal);
      expect(remove).toHaveBeenCalledOnce();
      expect(await host.artifactLeaseHost.inspectLease(lease.token)).toBeNull();
      expect(host.artifactRequest('session', 'seat', 2, 'cleanup')).toEqual(original);
      await owner.stop('session', 'seat', 3, new AbortController().signal);
      expect(remove).toHaveBeenCalledOnce();
      host.stop();
    },
  );
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

it('requires the discovery policy pin before launching an owned gateway', async () => {
  const f = fixture();
  f.options.runtime.policy = join(f.root, 'missing-policy');
  await expect(createOwnedSymposiumHost(f.options, f.launch)).rejects.toThrow();
  expect(f.launch).not.toHaveBeenCalled();
});

it('pins the owned gateway immutable config using its actual read-only file mode', async () => {
  const f = fixture();
  const path = join(f.root, 'gateway.toml');
  writeFileSync(path, 'owned config', { mode: 0o400 });
  const compose = vi.spyOn(personalHost, 'createPersonalSubscriptionHost');
  const operations = vi
    .spyOn(discoveryHost, 'createDiscoveryHostOperations')
    .mockImplementation(() => {
      throw new Error('captured');
    });
  const host = await createOwnedSymposiumHost(f.options, f.launch);
  const discover = compose.mock.calls[0][2]!;
  await expect(
    discover({
      provider: { name: 'personal', id: 'id' },
      account: { email: 'mock@example.test', planType: 'plus' },
      assertCurrent() {},
    }),
  ).rejects.toThrow('captured');
  expect(operations.mock.calls[0][1].configPins).toEqual([
    { path, sha256: expect.any(String), mode: statSync(path).mode & 0o777 },
  ]);
  expect(operations.mock.calls[0][1].configPins[0].mode).toBe(0o400);
  host.stop();
});

it('provisions a new draft through owned argv and makes its checked mapping available without replacing attestation', async () => {
  const f = fixture();
  const config = {
    version: 2,
    revision: 1,
    state: 'draft',
    anchorSeatId: 'seat',
    activeSeatCap: 3,
    seats: [
      {
        id: 'seat',
        name: 'Builder',
        model: 'luna',
        systemPrompt: 'Build',
        color: '#335577',
        role: 'coder',
      },
    ],
    turnRules: { mode: 'directed', maxTurns: 8 },
    interceptMode: 'manual',
  };
  f.options.facts.getSession = vi
    .fn()
    .mockReturnValue({ sessionType: 'symposium', symposiumConfig: JSON.stringify(config) });
  let volume: {
    Name: string;
    Driver: string;
    Options: object;
    Labels: Record<string, string>;
  } | null = null;
  const command = vi.fn(async (args: readonly string[]) => {
    if (args[1] === 'ls') return JSON.stringify(volume ? [volume] : []);
    if (args[1] === 'inspect') return JSON.stringify([volume]);
    if (args[1] === 'create') {
      const labels: Record<string, string> = {};
      args.forEach((v, i) => {
        if (v === '--label') {
          const [key, ...parts] = args[i + 1].split('=');
          labels[key] = parts.join('=');
        }
      });
      expect(args.slice(0, 4)).toEqual(['volume', 'create', '--driver', 'local']);
      volume = { Name: args.at(-1)!, Driver: 'local', Options: {}, Labels: labels };
      return volume.Name + '\n';
    }
    throw new Error('Unexpected command');
  });
  const before = readFileSync(f.options.attestationPath, 'utf8');
  const host = await createOwnedSymposiumHost(f.options, f.launch, undefined, command);
  try {
    expect(await host.ensureSessionArtifacts('new-session')).toEqual({ state: 'ready' });
    const request = host.artifactRequest('new-session', 'seat', 2);
    await host.artifactLeaseHost.reserve(request);
    vi.mocked(f.options.facts.getSymposiumSeatSandbox).mockReturnValue({
      sessionId: 'new-session',
      seatId: 'seat',
      generation: 2,
      workspace: 'workspace',
      sandboxName: null,
      physicalId: null,
      creationStarted: false,
    } as never);
    expect(request).toMatchObject({
      sessionId: 'new-session',
      access: 'writer',
      workspaceId: 'workspace',
    });
    expect(request.volumeName).toMatch(/^mitzo-artifacts-/);
    expect(await host.artifactLeaseHost.inspectVolume(request.volumeName, 'podman')).toMatchObject({
      labels: { 'mitzo.symposium.session': 'new-session' },
    });
    f.seat.role = 'reviewer';
    expect(host.artifactRequest('new-session', 'seat', 2).access).toBe('reviewer');
    expect(await host.ensureSessionArtifacts('new-session')).toEqual({ state: 'ready' });
    expect(command.mock.calls.filter(([args]) => args[1] === 'create')).toHaveLength(1);
    expect(readFileSync(f.options.attestationPath, 'utf8')).toBe(before);
    expect(host.runtimeConfig.cliContract).toBeUndefined();
    volume!.Labels['mitzo.symposium.session'] = 'wrong';
    expect(await host.ensureSessionArtifacts('new-session')).toEqual({
      state: 'recovery_required',
    });
    expect(() => host.artifactRequest('new-session', 'seat', 2)).toThrow('mapping');
    expect(host.artifactRequest('new-session', 'seat', 2, 'cleanup').volumeName).toBe(
      request.volumeName,
    );
    host.stop();
    const nextDirectory = join(f.root, 'next-gateway');
    mkdirSync(nextDirectory, { mode: 0o700 });
    const nextGateway = { ...f.gateway, stateDirectory: nextDirectory };
    const next = await createOwnedSymposiumHost(
      f.options,
      vi.fn().mockResolvedValue(nextGateway),
      undefined,
      command,
    );
    try {
      await expect(next.ensureSessionArtifacts('new-session')).rejects.toThrow(
        'different host custody',
      );
      expect(command.mock.calls.filter(([args]) => args[1] === 'create')).toHaveLength(1);
    } finally {
      next.stop();
    }
  } finally {
    host.stop();
  }
});

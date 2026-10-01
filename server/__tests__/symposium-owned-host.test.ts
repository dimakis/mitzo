import Database from 'better-sqlite3';
import type { DurableSymposiumReviewToolObservation } from '../symposium-codex-native.js';
import { EventStore } from '../event-store.js';
import { PhysicalArtifactSealer } from '../symposium-physical-artifact-seal.js';
import * as discoveryCore from '../symposium-model-discovery.js';
import * as discoveryCreation from '../symposium-discovery-creation.js';
import * as evidenceCollector from '../symposium-owned-evidence-async.js';
import { SymposiumPerSeatSandboxOwner } from '../symposium-session-runtime.js';
import { sandboxNameForConversation } from '../openshell-runtime.js';
import * as personalHost from '../symposium-personal-host.js';
import * as discoveryHost from '../symposium-model-discovery-host.js';
import * as sourceSeal from '../symposium-source-artifact-seal.js';
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
    stopAndWait: vi.fn().mockResolvedValue(undefined),
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
      workloadImage: 'sha256:a5a5302f2443c02f24506248883b9d22f070f58b288f898ac69a547b653e2161',
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
  it('sweeps abandoned ready review streams before exposing a fresh owner', async () => {
    const f = fixture();
    const events = new EventStore(join(f.root, 'facts.db'));
    f.options.facts = events;
    const sweep = vi.spyOn(PhysicalArtifactSealer.prototype, 'releaseAbandonedReadyReviewStreams');
    try {
      const host = await createOwnedSymposiumHost(f.options, f.launch);
      expect(sweep).toHaveBeenCalledOnce();
      host.stop();
    } finally {
      events.close();
    }
  });
  it('waits for a whole application transition before shutdown stream sweep', async () => {
    const f = fixture();
    const events = new EventStore(join(f.root, 'facts.db'));
    f.options.facts = events;
    const sweep = vi.spyOn(PhysicalArtifactSealer.prototype, 'releaseAbandonedReadyReviewStreams');
    try {
      const host = await createOwnedSymposiumHost(f.options, f.launch);
      let settle!: () => void;
      const running = host.trackApplicationTransition(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
      );
      host.beginShutdown();
      const signal = new AbortController().signal;
      const draining = host.drain(signal);
      await Promise.resolve();
      expect(sweep).toHaveBeenCalledTimes(1); // startup only
      settle();
      await running;
      await draining;
      expect(sweep).toHaveBeenCalledTimes(2); // drained transition
      await host.closeAfterDrain(signal);
      expect(sweep).toHaveBeenCalledTimes(3);
    } finally {
      events.close();
    }
  });
  it('fences admission and keeps custody stores readable until exact gateway exit completes', async () => {
    const f = fixture();
    let exited!: () => void;
    f.gateway.stopAndWait.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          exited = resolve;
        }),
    );
    const host = await createOwnedSymposiumHost(f.options, f.launch);
    const signal = new AbortController().signal;
    host.beginShutdown();
    expect(() => host.artifactRequest('session', 'seat', 2)).toThrow('shutting down');
    await expect(host.ensureSessionArtifacts('session')).rejects.toThrow('shutting down');
    await expect(host.beginDeviceLogin()).rejects.toThrow('shutting down');
    await host.drain(signal);
    const closing = host.closeAfterDrain(signal);
    expect(() => host.currentProfiles()).not.toThrow();
    await vi.waitFor(() => expect(f.gateway.stopAndWait).toHaveBeenCalledOnce());
    exited();
    await closing;
    expect(() => host.currentProfiles()).toThrow('stopped');
  });

  it('retains host stores when gateway exit cannot be established', async () => {
    const f = fixture();
    f.gateway.stopAndWait.mockRejectedValue(new Error('exit unknown'));
    const host = await createOwnedSymposiumHost(f.options, f.launch);
    const signal = new AbortController().signal;
    host.beginShutdown();
    await host.drain(signal);
    await expect(host.closeAfterDrain(signal)).rejects.toThrow('exit unknown');
    expect(() => host.currentProfiles()).not.toThrow();
    host.markShutdownUncertain();
    host.stop();
  });

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
    await expect(
      host.collectAdmissionEvidence({
        providerInstances: [{ name: 'p', id: 'i', type: 'codex', profileName: 'codex' }],
        allowedRoles: ['reviewer'],
        allowedAccountProviders: ['openai-codex'],
        artifactVolume: { driver: 'podman', name: 'volume' },
      }),
    ).rejects.toThrow('stopped');
  });
  it('keeps configured artifact mappings closed for new admission without receipts', async () => {
    const f = fixture();
    const host = await createOwnedSymposiumHost(f.options, f.launch);
    expect(() => host.artifactRequest('session', 'seat', 2)).toThrow('mapping');
    f.seat.role = 'reviewer';
    expect(() => host.artifactRequest('session', 'seat', 2)).toThrow('mapping');
    host.stop();
  });
  it('keeps an incomplete imported source out of bootstrap and execution readiness', async () => {
    const f = fixture();
    const host = await createOwnedSymposiumHost(f.options, f.launch);
    const db = new Database(join(f.root, 'session-artifacts.db'));
    try {
      expect(host.preinitialSource('session')).toBe(false);
      expect(host.artifactReady('session', 'seat', 2)).toBe(true);
      db.prepare(
        `INSERT INTO symposium_session_artifacts
        (session_id,workspace,custody,volume_name,generation,state,source_import_json,source_seal_json)
        VALUES (?,?,?,?,?,'ready',?,?)`,
      ).run(
        'session',
        'workspace',
        f.root,
        'source-volume',
        'source-generation',
        JSON.stringify({ receipt: { operationId: 'import' } }),
        JSON.stringify({ state: 'pending' }),
      );
      expect(() => host.preinitialSource('session')).toThrow('completed source seal');
      expect(() => host.artifactReady('session', 'seat', 2)).toThrow('completed source seal');
      f.gateway.verifyCustody.mockImplementation(() => {
        throw new Error('custody lost');
      });
      expect(() => host.artifactReady('session', 'seat', 2)).toThrow('custody lost');
    } finally {
      db.close();
      host.stop();
    }
  });
  it.each(['suspended', 'removed'])(
    'retains exact artifact cleanup identity after %s and role replacement',
    async (state) => {
      const f = fixture();
      const host = await createOwnedSymposiumHost(f.options, f.launch, undefined, async () => '[]');
      const sandboxName = sandboxNameForConversation('old-runtime', 13);
      const original = {
        sessionId: 'session',
        seatId: 'seat',
        workspaceId: 'workspace',
        volumeName: 'artifacts',
        volumeGeneration: 'generation',
        driver: 'podman' as const,
        access: 'writer' as const,
      };
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
  const collect = vi.fn(async (selection: unknown) => selection as never);
  vi.spyOn(evidenceCollector, 'createOwnedEvidenceCollector').mockReturnValue(collect);
  const originalPersonalHost = personalHost.createPersonalSubscriptionHost;
  const assertCurrent = vi.fn();
  vi.spyOn(personalHost, 'createPersonalSubscriptionHost').mockImplementation((...args) => ({
    ...originalPersonalHost(...args),
    captureAdmissionProvider: () => ({
      provider: {
        name: 'retained-personal',
        id: 'retained-id',
        type: 'codex',
        profileName: 'codex',
      },
      assertCurrent,
    }),
  }));
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
  let afterInspection: (() => Promise<void>) | undefined;
  const command = vi.fn(async (args: readonly string[], execution?: { timeout: number }) => {
    if (args[1] === 'ls') return JSON.stringify(volume ? [volume] : []);
    if (args[1] === 'inspect') {
      const result = JSON.stringify([volume]);
      const hook = afterInspection;
      afterInspection = undefined;
      await hook?.();
      return result;
    }
    if (args[1] === 'create') {
      const labels: Record<string, string> = {};
      args.forEach((v, i) => {
        if (v === '--label') {
          const [key, ...parts] = args[i + 1].split('=');
          labels[key] = parts.join('=');
        }
      });
      expect(args.slice(0, 8)).toEqual([
        'volume',
        'create',
        '--driver',
        'local',
        '--uid',
        '998',
        '--gid',
        '998',
      ]);
      volume = { Name: args.at(-1)!, Driver: 'local', Options: {}, Labels: labels };
      return volume.Name + '\n';
    }
    if (args[0] === 'create') {
      expect(args).toContain('--network=none');
      expect(args).toContain(`type=volume,src=${volume!.Name},dst=/sandbox/workspaces/mgmt`);
      return 'a'.repeat(64);
    }
    if (args[0] === 'start') {
      expect(execution?.timeout).toBe(60_000);
      return 'MITZO_GIT_INITIALIZED_V1\n';
    }
    if (args[0] === 'rm') {
      expect(args).toEqual(['rm', 'a'.repeat(64)]);
      return 'a'.repeat(64);
    }
    throw new Error('Unexpected command');
  });
  const before = readFileSync(f.options.attestationPath, 'utf8');
  const host = await createOwnedSymposiumHost(f.options, f.launch, undefined, command);
  try {
    expect(await host.ensureSessionArtifacts('new-session')).toEqual({ state: 'ready' });
    expect(host.preinitialSource('new-session')).toBe(false);
    expect(host.artifactReady('new-session', 'seat', 2)).toBe(true);
    expect(host.sourceImport.status('new-session')).toMatchObject({
      available: true,
      admissionIssued: false,
    });
    const personalSelection = {
      personalConnection: { connectionId: 'personal', expectedRevision: 3 },
      sessionId: 'new-session',
      allowedRoles: ['coder'],
    };
    const candidate = await host.collectAdmissionEvidence(personalSelection);
    expect(host.sourceImport.status('new-session')).toMatchObject({
      available: false,
      admissionIssued: true,
    });
    expect(candidate).toMatchObject({
      providerInstances: [{ name: 'retained-personal', id: 'retained-id' }],
      artifactVolume: { name: volume!.Name },
    });
    expect(assertCurrent).toHaveBeenCalled();
    volume!.Labels['mitzo.symposium.session'] = 'wrong-session';
    await expect(host.collectAdmissionEvidence(personalSelection)).rejects.toThrow();
    expect(collect).toHaveBeenCalledTimes(1);
    volume!.Labels['mitzo.symposium.session'] = 'new-session';
    collect.mockImplementationOnce(async (selection) => {
      vi.mocked(f.options.facts.getSession!).mockReturnValue({
        sessionType: 'chat',
        symposiumConfig: null,
      } as never);
      return selection as never;
    });
    await expect(host.collectAdmissionEvidence(personalSelection)).rejects.toThrow('draft');
    vi.mocked(f.options.facts.getSession!).mockReturnValue({
      sessionType: 'symposium',
      symposiumConfig: JSON.stringify(config),
    } as never);

    collect.mockImplementationOnce(async (selection) => {
      afterInspection = async () => {
        volume!.Labels['mitzo.symposium.session'] = 'contradictory-session';
        expect(await host.ensureSessionArtifacts('new-session')).toEqual({
          state: 'recovery_required',
        });
        volume!.Labels['mitzo.symposium.session'] = 'new-session';
      };
      return selection as never;
    });
    await expect(host.collectAdmissionEvidence(personalSelection)).rejects.toThrow(
      'readiness changed',
    );
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

it.each(['beginLogin', 'beginDeviceLogin'] as const)(
  'drains a confirmed shutdown cancellation while %s is still allocating',
  async (method) => {
    const f = fixture();
    let finish!: (value: never) => void;
    const allocate = vi.fn(
      () =>
        new Promise<never>((resolve) => {
          finish = resolve;
        }),
    );
    const original = personalHost.createPersonalSubscriptionHost;
    vi.spyOn(personalHost, 'createPersonalSubscriptionHost').mockImplementation((...args) => {
      const subscription = original(...args);
      return { ...subscription, [method]: allocate };
    });
    const host = await createOwnedSymposiumHost(f.options, f.launch);
    const pending = host[method]();
    const rejected = expect(pending).rejects.toThrow('stopped');
    host.beginShutdown();
    const draining = host.drain(new AbortController().signal);
    const cancel = vi.fn().mockResolvedValue(undefined);
    finish({ completed: new Promise(() => {}), cancel } as never);
    await rejected;
    await expect(draining).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
    await host.closeAfterDrain(new AbortController().signal);
  },
);

it('does not suppress a failed cancellation of a late login', async () => {
  const f = fixture();
  let finish!: (value: never) => void;
  const original = personalHost.createPersonalSubscriptionHost;
  vi.spyOn(personalHost, 'createPersonalSubscriptionHost').mockImplementation((...args) => ({
    ...original(...args),
    beginDeviceLogin: () =>
      new Promise<never>((resolve) => {
        finish = resolve;
      }),
  }));
  const host = await createOwnedSymposiumHost(f.options, f.launch);
  const pending = host.beginDeviceLogin();
  const rejected = expect(pending).rejects.toThrow('cleanup unknown');
  host.beginShutdown();
  const draining = expect(host.drain(new AbortController().signal)).rejects.toThrow(
    'did not settle cleanly',
  );
  finish({
    completed: new Promise(() => {}),
    cancel: vi.fn().mockRejectedValue(new Error('cleanup unknown')),
  } as never);
  await rejected;
  await draining;
  expect(f.gateway.stopAndWait).not.toHaveBeenCalled();
  host.stop();
});

it('still cancels active login and drains workspace when a tracked operation fails', async () => {
  const { SymposiumWorkspaceLifecycle } = await import('../symposium-workspace-lifecycle.js');
  const f = fixture();
  let finish!: () => void;
  const cancel = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const original = personalHost.createPersonalSubscriptionHost;
  vi.spyOn(personalHost, 'createPersonalSubscriptionHost').mockImplementation((...args) => ({
    ...original(...args),
    beginLogin: async () =>
      ({
        authorizationUrl: 'https://example.invalid',
        completed: new Promise(() => {}),
        cancel,
      }) as never,
  }));
  const workspace = vi.spyOn(SymposiumWorkspaceLifecycle.prototype, 'drain');
  const host = await createOwnedSymposiumHost(f.options, f.launch);
  await host.beginLogin();
  const failed = host.ensureSessionArtifacts('session').catch(() => {});
  host.beginShutdown();
  const drain = expect(host.drain(new AbortController().signal)).rejects.toThrow(
    'did not settle cleanly',
  );
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  expect(workspace).not.toHaveBeenCalled();
  finish();
  await drain;
  await failed;
  expect(workspace).toHaveBeenCalledOnce();
  host.stop();
});

it('preserves safe diagnostic fields when the host forces creation reconciliation', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'gateway.toml'), 'owned config', { mode: 0o400 });
  const compose = vi.spyOn(personalHost, 'createPersonalSubscriptionHost');
  vi.spyOn(discoveryHost, 'createDiscoveryHostOperations').mockReturnValue({} as never);
  vi.spyOn(discoveryCreation, 'fenceDiscoveryCreation').mockReturnValue({
    operations: {} as never,
    creationUncertain: () => true,
  });
  const diagnostic = {
    stage: 'create',
    failureClass: 'timeout',
    createDispatch: 'possibly-dispatched',
    commandDispatch: 'possibly-started',
    recordedAt: new Date().toISOString(),
  } as const;
  vi.spyOn(discoveryCore, 'runSymposiumModelDiscovery').mockResolvedValue({
    status: 'failed',
    inference: false,
    diagnostic,
    diagnosticPersisted: false,
  });
  const host = await createOwnedSymposiumHost(f.options, f.launch);
  try {
    const response = await compose.mock.calls[0][2]!({
      provider: { name: 'personal', id: 'id' },
      account: { email: 'mock@example.test', planType: 'plus' },
      assertCurrent() {},
    });
    expect(response).toEqual({
      result: {
        status: 'reconciliation_required',
        inference: false,
        diagnostic,
        diagnosticPersisted: false,
      },
    });
  } finally {
    host.stop();
  }
});

it('rejects an unreviewed workload owner before launching the gateway', async () => {
  const f = fixture();
  f.options.gateway.workloadImage = `sha256:${'f'.repeat(64)}`;
  await expect(createOwnedSymposiumHost(f.options, f.launch)).rejects.toThrow(
    'identity is not reviewed',
  );
  expect(f.launch).not.toHaveBeenCalled();
});

it('retains the lease ledger across different launch directories and blocks legacy launch databases', async () => {
  const f = fixture();
  const firstDirectory = join(f.root, 'gateway-first');
  mkdirSync(firstDirectory, { mode: 0o700 });
  f.gateway.stateDirectory = firstDirectory;
  const first = await createOwnedSymposiumHost(f.options, f.launch);
  const request = {
    sessionId: 'session',
    workspaceId: 'workspace',
    seatId: 'seat',
    volumeName: 'artifacts',
    volumeGeneration: 'generation',
    driver: 'podman' as const,
    access: 'writer' as const,
  };
  const lease = await first.artifactLeaseHost.reserve(request);
  first.artifactLeaseHost.markCreationStarted(lease.token, lease.revision, 'writer');
  await first.closeAfterDrain(new AbortController().signal);
  const secondDirectory = join(f.root, 'gateway-second');
  mkdirSync(secondDirectory, { mode: 0o700 });
  const second = await createOwnedSymposiumHost(
    f.options,
    vi.fn().mockResolvedValue({ ...f.gateway, stateDirectory: secondDirectory }),
  );
  try {
    expect(await second.artifactLeaseHost.inspectLease(lease.token)).toEqual(lease);
    await expect(
      second.artifactLeaseHost.reserve({ ...request, seatId: 'replacement' }),
    ).rejects.toThrow(/already has a writer/);
  } finally {
    await second.closeAfterDrain(new AbortController().signal);
  }
  writeFileSync(join(firstDirectory, 'artifact-leases.db'), 'legacy unresolved state', {
    mode: 0o600,
  });
  const launch = vi.fn();
  await expect(createOwnedSymposiumHost(f.options, launch)).rejects.toThrow(
    /requires reconciliation/,
  );
  expect(launch).not.toHaveBeenCalled();
});

it.each(['create', 'rm'])(
  'journals terminal initializer %s through actual owned transport before custody loss',
  async (boundary) => {
    const f = fixture();
    f.options.facts.getSession = vi.fn().mockReturnValue({
      sessionType: 'symposium',
      symposiumConfig: JSON.stringify({
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
      }),
    });
    const command = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'volume' && args[1] === 'ls') return '[]';
      if (args[0] === 'volume' && args[1] === 'create') return args.at(-1)!;
      if (args[0] === 'start') return 'MITZO_GIT_INITIALIZED_V1';
      if (args[0] === boundary) {
        f.gateway.verifyCustody.mockImplementation(() => {
          throw new Error('custody lost');
        });
        return 'b'.repeat(64);
      }
      if (args[0] === 'create') return 'b'.repeat(64);
      throw new Error('Unexpected command');
    });
    const host = await createOwnedSymposiumHost(f.options, f.launch, undefined, command);
    try {
      expect(await host.ensureSessionArtifacts('new-session')).toEqual({
        state: 'recovery_required',
      });
      const db = new Database(join(f.root, 'session-artifacts.db'), { readonly: true });
      const row = db
        .prepare(
          'SELECT initializer_id,initializer_removed,initialization_contract FROM symposium_session_artifacts',
        )
        .get();
      db.close();
      expect(row).toEqual({
        initializer_id: 'b'.repeat(64),
        initializer_removed: boundary === 'rm' ? 1 : 0,
        initialization_contract: null,
      });
      expect(command.mock.calls.some(([args]) => args[0] === 'start')).toBe(boundary === 'rm');
    } finally {
      f.gateway.verifyCustody.mockReset();
      host.stop();
    }
  },
);

it.each(['create', 'rm'])(
  'preserves exact snapshot %s result before post-command custody loss',
  async (boundary) => {
    const f = fixture();
    const command = vi.fn(async () => {
      f.gateway.verifyCustody.mockImplementation(() => {
        throw new Error('custody lost');
      });
      return 'b'.repeat(64);
    });
    const host = await createOwnedSymposiumHost(f.options, f.launch, undefined, command);
    try {
      const snapshot = host.artifactLeaseHost.snapshotCommand();
      await expect(snapshot([boundary, 'exact-helper'])).resolves.toBe('b'.repeat(64));
      await expect(snapshot(['inspect', 'exact-helper'])).rejects.toThrow('custody lost');
      expect(command).toHaveBeenCalledTimes(1);
    } finally {
      f.gateway.verifyCustody.mockReset();
      host.stop();
    }
  },
);

it('marks only a retained transport precheck rejection as not dispatched', async () => {
  const f = fixture();
  const command = vi.fn(async () => {
    throw new Error('command completion unknown');
  });
  const host = await createOwnedSymposiumHost(f.options, f.launch, undefined, command);
  try {
    const snapshot = host.artifactLeaseHost.snapshotCommand();
    f.gateway.verifyCustody.mockImplementation(() => {
      throw new Error('custody lost');
    });
    await expect(snapshot(['create', 'exact-helper'])).rejects.toMatchObject({
      name: 'ArtifactCommandNotDispatched',
    });
    expect(command).not.toHaveBeenCalled();
    f.gateway.verifyCustody.mockReset();
    await expect(snapshot(['create', 'exact-helper'])).rejects.not.toMatchObject({
      name: 'ArtifactCommandNotDispatched',
    });
    expect(command).toHaveBeenCalledOnce();
  } finally {
    f.gateway.verifyCustody.mockReset();
    host.stop();
  }
});

it('passes bounded successor stdin through the owned transport with the attached deadline', async () => {
  const f = fixture();
  const command = vi.fn(async () => 'terminal');
  const host = await createOwnedSymposiumHost(f.options, f.launch, undefined, command);
  try {
    const input = Buffer.from('disposable test bundle');
    const args = ['start', '--attach', '--interactive', 'a'.repeat(64)];
    await host.artifactLeaseHost.snapshotCommand()(args, 4096, input);
    expect(command).toHaveBeenCalledWith(args, { timeout: 60000, input });
  } finally {
    await host.stop();
  }
});

it('dispatches the bounded source seal verifier export without widening other Podman commands', async () => {
  const f = fixture();
  const command = vi.fn(async () => 'sealed-export');
  const host = await createOwnedSymposiumHost(f.options, f.launch, undefined, command);
  try {
    const snapshot = host.artifactLeaseHost.snapshotCommand();
    const helperId = 'a'.repeat(64);
    const sealBound = 16 * 1024 * 1024;
    await expect(snapshot(['start', '--attach', helperId], sealBound)).resolves.toBe(
      'sealed-export',
    );
    await expect(snapshot(['logs', helperId], sealBound)).resolves.toBe('sealed-export');
    expect(command).toHaveBeenNthCalledWith(1, ['start', '--attach', helperId], {
      timeout: 60_000,
    });
    expect(command).toHaveBeenNthCalledWith(2, ['logs', helperId], { timeout: 15_000 });
    await expect(snapshot(['inspect', helperId], sealBound)).rejects.toThrow(
      'Owned Podman output bound is invalid',
    );
    await expect(snapshot(['start', '--attach', 'not-an-id'], sealBound)).rejects.toThrow(
      'Owned Podman output bound is invalid',
    );
    await expect(snapshot(['start', '--attach', helperId], sealBound + 1)).rejects.toThrow(
      'Owned Podman output bound is invalid',
    );
    expect(command).toHaveBeenCalledTimes(2);
  } finally {
    await host.stop();
  }
});

it('keeps the production successor capability unavailable without a trusted fix authority', async () => {
  const f = fixture();
  const command = vi.fn(async () => 'unexpected');
  const host = await createOwnedSymposiumHost(f.options, f.launch, undefined, command);
  try {
    await expect(
      host.copySuccessorArtifact(
        {} as never,
        {} as never,
        Buffer.alloc(0),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/fix authority unavailable/);
    expect(command).not.toHaveBeenCalled();
  } finally {
    await host.stop();
  }
});

it('waits for the entire source import receipt lifecycle during shutdown between command boundaries', async () => {
  const source = await import('../symposium-source-service.js');
  const f = fixture();
  let entered!: () => void,
    release!: () => void,
    sealEntered!: () => void,
    sealRelease!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sealing = new Promise<void>((resolve) => {
    sealEntered = resolve;
  });
  const sealGate = new Promise<void>((resolve) => {
    sealRelease = resolve;
  });
  let receiptPersisted = false;
  vi.spyOn(source, 'createSymposiumSourceHost').mockReturnValue({
    status: () => ({ available: false, state: 'recovery_required' }),
    import: async () => {
      entered();
      await gate;
      receiptPersisted = true;
      return { operationId: 'import-operation' } as never;
    },
  });
  vi.spyOn(sourceSeal, 'sealImportedSourceArtifact').mockImplementation(async () => {
    sealEntered();
    await sealGate;
    return {} as never;
  });
  const host = await createOwnedSymposiumHost(f.options, f.launch);
  const operation = host.sourceImport.import({} as never, () => {});
  await started;
  host.beginShutdown();
  const stopping = (async () => {
    const signal = new AbortController().signal;
    await host.drain(signal);
    await host.closeAfterDrain(signal);
  })();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(f.gateway.stopAndWait).not.toHaveBeenCalled();
  release();
  await sealing;
  expect(f.gateway.stopAndWait).not.toHaveBeenCalled();
  sealRelease();
  await operation;
  await stopping;
  expect(receiptPersisted).toBe(true);
  expect(f.gateway.stopAndWait).toHaveBeenCalledOnce();
});
it('retains personal custody across controller quiescence without permanent host shutdown', async () => {
  const f = fixture();
  const host = await createOwnedSymposiumHost(f.options, f.launch);
  try {
    const original = host.personalConnections.create('retained account');
    host.pauseController();
    expect(() => host.personalConnections.create('blocked')).toThrow('controller');
    await host.quiesceController(new AbortController().signal);
    expect(host.personalConnections.list()).toContainEqual(original);
    expect(f.gateway.stop).not.toHaveBeenCalled();
    host.resumeController();
    expect(host.personalConnections.create('new slot').label).toBe('new slot');
    host.beginShutdown();
    expect(() => host.resumeController()).toThrow('shutting down');
  } finally {
    host.stop();
  }
});

it.each(['beginLogin', 'beginDeviceLogin'] as const)(
  'quiesces a late %s allocation before replacing the controller',
  async (method) => {
    const f = fixture();
    let finish!: (value: never) => void;
    const original = personalHost.createPersonalSubscriptionHost;
    vi.spyOn(personalHost, 'createPersonalSubscriptionHost').mockImplementation((...args) => ({
      ...original(...args),
      [method]: () =>
        new Promise<never>((resolve) => {
          finish = resolve;
        }),
    }));
    const host = await createOwnedSymposiumHost(f.options, f.launch);
    try {
      const pending = host[method]();
      const rejected = expect(pending).rejects.toThrow('stopped');
      host.pauseController();
      const drain = host.quiesceController(new AbortController().signal);
      const cancel = vi.fn().mockResolvedValue(undefined);
      finish({ completed: new Promise(() => {}), cancel } as never);
      await rejected;
      await expect(drain).resolves.toBeUndefined();
      expect(cancel).toHaveBeenCalledOnce();
      expect(f.gateway.stopAndWait).not.toHaveBeenCalled();
      host.resumeController();
    } finally {
      host.stop();
    }
  },
);

it('quarantines failed cleanup of a login allocated after controller pause', async () => {
  const f = fixture();
  let finish!: (value: never) => void;
  const original = personalHost.createPersonalSubscriptionHost;
  vi.spyOn(personalHost, 'createPersonalSubscriptionHost').mockImplementation((...args) => ({
    ...original(...args),
    beginLogin: () =>
      new Promise<never>((resolve) => {
        finish = resolve;
      }),
  }));
  const host = await createOwnedSymposiumHost(f.options, f.launch);
  try {
    const rejected = expect(host.beginLogin()).rejects.toThrow('cleanup unknown');
    host.pauseController();
    const drain = expect(host.quiesceController(new AbortController().signal)).rejects.toThrow(
      'uncertain',
    );
    finish({
      completed: new Promise(() => {}),
      cancel: vi.fn().mockRejectedValue(Error('cleanup unknown')),
    } as never);
    await rejected;
    await drain;
    expect(() => host.resumeController()).toThrow('uncertain');
    expect(f.gateway.stopAndWait).not.toHaveBeenCalled();
  } finally {
    host.stop();
  }
});

it('carries semantic deadlines and bounded stdin into the real retained owned transport while legacy defaults remain unchanged', async () => {
  const f = fixture();
  const command = vi.fn(async () => 'bounded output');
  const host = await createOwnedSymposiumHost(f.options, f.launch, undefined, command);
  try {
    const retained = host.artifactLeaseHost!.snapshotCommand(),
      cid = 'a'.repeat(64),
      input = Buffer.from('[]\n');
    await retained(['start', '--attach', '--interactive', cid], 16384, input, 5000);
    expect(command).toHaveBeenLastCalledWith(['start', '--attach', '--interactive', cid], {
      timeout: 5000,
      input,
    });
    await retained(['inspect', cid], 16384, undefined, 1234);
    expect(command).toHaveBeenLastCalledWith(['inspect', cid], { timeout: 1234 });
    await retained(['start', '--attach', cid]);
    expect(command).toHaveBeenLastCalledWith(['start', '--attach', cid], { timeout: 60000 });
  } finally {
    host.stop();
  }
});

const observerEvent: DurableSymposiumReviewToolObservation = Object.freeze({
  sessionId: 'session',
  claimToken: 'claim',
  deliveryId: 'delivery',
  seatId: 'reader',
  membershipGeneration: 2,
  providerThreadId: 'thread',
  providerTurnId: 'turn',
  callId: 'call',
  toolName: 'review_page',
  arguments: Object.freeze({ page: 0 }),
  result: Object.freeze({ content: '{}', isError: false }),
});
describe('constructor-only original owned observer', () => {
  it('pins the constructor callback before gateway launch awaits', async () => {
    const f = fixture();
    const original = vi.fn();
    const replacement = vi.fn();
    f.options.observeDurableReviewToolResult = original;
    let release!: () => void;
    const launching = createOwnedSymposiumHost(f.options, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return f.gateway as unknown as OwnedSymposiumGateway;
    });
    f.options.observeDurableReviewToolResult = replacement;
    release();
    const host = await launching;
    await host.observeDurableReviewToolResult!(observerEvent);
    expect(original).toHaveBeenCalledExactlyOnceWith(observerEvent);
    expect(replacement).not.toHaveBeenCalled();
    host.stop();
  });

  it('is absent for the ordinary default host', async () => {
    const f = fixture();
    const host = await createOwnedSymposiumHost(f.options, f.launch);
    expect(host.observeDurableReviewToolResult).toBeUndefined();
    host.stop();
  });
  it('routes the exact immutable native event through the original host callback', async () => {
    const f = fixture();
    const observer = vi.fn();
    f.options.observeDurableReviewToolResult = observer;
    const host = await createOwnedSymposiumHost(f.options, f.launch);
    f.gateway.verifyCustody.mockClear();
    await host.observeDurableReviewToolResult!(observerEvent);
    expect(observer).toHaveBeenCalledExactlyOnceWith(observerEvent);
    expect(f.gateway.verifyCustody.mock.calls.length).toBeGreaterThanOrEqual(2);
    host.stop();
  });
  it.each(['custody', 'controller'] as const)(
    'vetoes %s loss while the original observer awaits',
    async (loss) => {
      const f = fixture();
      let release!: () => void;
      f.options.observeDurableReviewToolResult = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const host = await createOwnedSymposiumHost(f.options, f.launch);
      const result = host.observeDurableReviewToolResult!(observerEvent);
      if (loss === 'custody')
        f.gateway.verifyCustody.mockImplementation(() => {
          throw Error('original custody lost');
        });
      else host.pauseController();
      release();
      await expect(result).rejects.toThrow();
      await expect(host.observeDurableReviewToolResult!(observerEvent)).rejects.toThrow();
      expect(f.options.observeDurableReviewToolResult).toHaveBeenCalledOnce();
      host.stop();
    },
  );
});

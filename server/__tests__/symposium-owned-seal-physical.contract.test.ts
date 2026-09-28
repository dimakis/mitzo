/** Opt-in, credential-free physical seal. The writer volume, native controller,
 * retained Podman container, lease, runtime drain, verifier, and criterion helper
 * are real. Gateway inventory/absence and provider identity are fixture authority;
 * this does not prove a live owned-gateway or model-backed application run. */
import { expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../account-profiles.js';
import { EventStore } from '../event-store.js';
import { initializeSymposiumNativeHost } from '../symposium-native-host.js';
import {
  ArtifactPodmanContext,
  SqliteArtifactLeaseHost,
  volumeEvidence,
} from '../symposium-artifact-host.js';
import { createArtifactGitVolume, artifactGitContract } from '../symposium-artifact-initializer.js';
import { symposiumArtifactOwner } from '../symposium-artifact-owner.js';
import { SYMPOSIUM_ARTIFACT_TARGET as target } from '../symposium-artifact-lease.js';
import { PhysicalArtifactSealer } from '../symposium-physical-artifact-seal.js';
import { REVIEWED_SYMPOSIUM_OWNED_RUNTIME as runtimeImage } from '../symposium-owned-runtime-contract.js';
import { SymposiumSessionArtifacts } from '../symposium-session-artifacts.js';
import { createSymposiumSessionRuntime } from '../symposium-session-runtime.js';
import { OpenShellRuntimeManager, sandboxNameForConversation } from '../openshell-runtime.js';

const physical = process.env.MITZO_OWNED_SEAL_PHYSICAL_CONTRACT === '1';
it.skipIf(!physical)(
  'drains a retained physical writer and seals the exact committed criterion',
  async () => {
    execFileSync('git', ['diff', '--quiet', 'HEAD']);
    const root = mkdtempSync(join(tmpdir(), 'mitzo-owned-seal-contract-'));
    const sessionId = randomUUID();
    const workspace = 'owned-seal-contract';
    const image = runtimeImage.build.image;
    const owner = symposiumArtifactOwner(image);
    const database = join(root, 'custody.db');
    const env = { HOME: process.env.HOME, PATH: process.env.PATH };
    const command = async (
      args: readonly string[],
      maxOutputBytes = 16 * 1024 * 1024,
      input?: Buffer,
    ) =>
      execFileSync(process.env.MITZO_CONTRACT_PODMAN ?? 'podman', [...args], {
        env,
        input,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: maxOutputBytes,
      });
    const podman = (...args: string[]) =>
      execFileSync(process.env.MITZO_CONTRACT_PODMAN ?? 'podman', args, {
        env,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 16 * 1024 * 1024,
      }).trim();
    const absent = (id: string) => {
      const inspected = spawnSync(process.env.MITZO_CONTRACT_PODMAN ?? 'podman', ['inspect', id], {
        env,
        encoding: 'utf8',
        timeout: 15000,
      });
      if (inspected.error || inspected.status === null)
        throw Error('Podman inspection unavailable');
      if (inspected.status === 0) return false;
      if (inspected.status !== 125 || !inspected.stderr.includes(`no such object: "${id}"`))
        throw Error('Podman absence proof unavailable');
      return true;
    };
    const volumes: string[] = [];
    const artifacts = new SymposiumSessionArtifacts(database, workspace, root, () => {}, {
      initializationContract: artifactGitContract(owner),
      initializerRequired: true,
      inspect: async (name) => {
        const rows = JSON.parse(
          await command(['volume', 'ls', '--filter', `name=^${name}$`, '--format', 'json']),
        );
        return rows.length
          ? volumeEvidence(JSON.parse(await command(['volume', 'inspect', name])), name)
          : null;
      },
      create: (name, labels, receipt) => {
        volumes.push(name);
        return createArtifactGitVolume(name, labels, owner, command, () => {}, receipt);
      },
    });
    const gateway = {
      workspace,
      stateDirectory: root,
      verifyCustody() {},
      async verifyCustodyAsync() {},
    };
    const leaseHost = new SqliteArtifactLeaseHost(
      join(root, 'leases.db'),
      {
        verifyGateway: async () => {},
        verifyMount: async () => {},
        verifyDeleted: async (_name, id) => {
          if (!absent(id)) throw Error('physical sandbox remains');
        },
      },
      new ArtifactPodmanContext(command),
      gateway as never,
    );
    const events = new EventStore(database);
    const native = initializeSymposiumNativeHost(join(root, 'attempts'));
    let sealer: PhysicalArtifactSealer | undefined;
    let sandboxId: string | undefined;
    let completed = false;
    try {
      expect(await artifacts.ensure(sessionId)).toEqual({ state: 'ready' });
      const mapping = artifacts.getReady(sessionId)!;
      const account = {
        accountId: 'offline-fixture',
        accountLabel: 'Offline fixture',
        provider: 'openai' as const,
        model: 'offline-no-call',
        profileRevision: '1',
      };
      const seat = {
        id: 'writer',
        name: 'Writer',
        role: 'coder' as const,
        model: account.model,
        systemPrompt: 'Credential-free fixture',
        color: '#335577',
        accountBinding: account,
        profileBinding: { profileId: 'writer', profileRevision: '1' },
        contextGrant: {
          grantId: 'context',
          revision: 1,
          classification: 'work' as const,
          sourceRefs: [],
        },
        authorityGrant: {
          grantId: 'authority',
          revision: 1,
          filesystem: 'write' as const,
          tools: 'write' as const,
          network: 'restricted' as const,
        },
        isolationRequest: {
          trustDomainId: 'fixture',
          revision: 1,
          placement: 'reuse-compatible' as const,
        },
      };
      events.upsertSession({ sessionId, accountBinding: account });
      events.setSymposiumConfig(sessionId, {
        version: 2,
        revision: 1,
        state: 'active',
        anchorSeatId: 'writer',
        activeSeatCap: 1,
        seats: [seat],
        turnRules: { mode: 'directed', maxTurns: 1 },
        interceptMode: 'manual',
      });
      events.transitionSymposiumMembership({
        sessionId,
        seatId: 'writer',
        action: 'admit',
        expectedGeneration: 0,
        configRevision: 1,
        actor: 'fixture',
        reason: 'disposable',
        idempotencyKey: 'admit-writer',
        occurredAt: Date.now(),
      });
      events.markSymposiumMembershipReconciled(sessionId, 'writer', 1, 'confirmed');
      const leaseRequest = {
        sessionId,
        workspaceId: workspace,
        seatId: 'writer',
        volumeName: mapping.volumeName,
        volumeGeneration: mapping.volumeGeneration,
        driver: 'podman' as const,
        access: 'writer' as const,
      };
      const lease = await leaseHost.reserve(leaseRequest);
      const runtimeId = randomUUID();
      const sandboxName = sandboxNameForConversation(runtimeId, 13);
      leaseHost.markCreationStarted(lease.token, lease.revision, sandboxName);
      sandboxId = podman(
        'create',
        '--pull=never',
        '--name',
        sandboxName,
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user',
        'sandbox',
        '--tmpfs',
        '/sandbox:rw,mode=1777',
        '--volume',
        `${mapping.volumeName}:${target}:rw`,
        '--entrypoint=/bin/sleep',
        image,
        '300',
      );
      expect(sandboxId).toMatch(/^[a-f0-9]{64}$/);
      podman('start', sandboxId);
      leaseHost.bindSandbox(lease.token, lease.revision, sandboxName, sandboxId);
      const sandbox = {
        sessionId,
        seatId: 'writer',
        generation: 1,
        runtimeId,
        workspace,
        providerName: 'offline',
        providerId: 'offline',
        providerType: 'openai',
        model: account.model,
      };
      events.reserveSymposiumSeatSandbox(sandbox);
      events.markSymposiumSeatSandboxCreationStarted(sandbox);
      events.confirmSymposiumSeatSandbox({ ...sandbox, sandboxName, physicalId: sandboxId });
      events.markSymposiumSeatSandboxCreationCompleted({ ...sandbox, physicalId: sandboxId });
      const code = `import subprocess,pathlib\nr='${target}'\np=pathlib.Path(r+'/criterion.txt')\np.write_text('SEALED_NATIVE\\n')\nsubprocess.check_call(['git','-C',r,'add','criterion.txt'])\nsubprocess.check_call(['git','-C',r,'-c','user.name=Contract','-c','user.email=contract@example.invalid','-c','commit.gpgsign=false','commit','-qm','native writer'])`;
      const claim = createHash('sha256').update(randomUUID()).digest('hex');
      podman(
        'exec',
        '--user',
        'sandbox',
        sandboxId,
        '/usr/local/bin/symposium-attempt-controller',
        'run',
        claim,
        'write',
        '/usr/bin/python3',
        '-I',
        '-B',
        '-c',
        code,
      );
      const controller = JSON.parse(
        podman(
          'exec',
          '--user',
          'sandbox',
          sandboxId,
          '/usr/bin/cat',
          `/sandbox/.symposium-control/${claim}.done`,
        ),
      );
      expect(controller).toMatchObject({ claim, terminal: true, exit_code: 0 });
      const writerCommit = podman(
        'exec',
        '--user',
        'sandbox',
        sandboxId,
        '/usr/bin/git',
        '-C',
        target,
        'rev-parse',
        'HEAD',
      );
      expect(writerCommit).toMatch(/^[a-f0-9]{40}$/);
      const runtimeConfig = {
        cli: 'openshell',
        cliContract: 'v0.1' as const,
        image,
        policy: '/fixture-policy',
        seed: '/fixture-seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace,
        gateway: 'fixture-gateway',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled' as const,
      };
      const phase = async () => {
        if (absent(sandboxId!)) return undefined;
        const row = JSON.parse(podman('inspect', sandboxId!))[0];
        return {
          phase: row.State.Running ? ('Ready' as const) : ('Stopped' as const),
          id: sandboxId!,
          name: sandboxName,
        };
      };
      const managerFactory = () => ({
        ensure: async () => {
          throw Error('fixture manager cannot create another sandbox');
        },
        inspect: phase,
        inspectReserved: phase,
        stop: async () => {
          podman('stop', sandboxId!);
        },
        delete: async () => {
          podman('rm', sandboxId!);
        },
      });
      vi.spyOn(OpenShellRuntimeManager.prototype, 'inspectReserved').mockImplementation(
        async () => (await phase()) as never,
      );
      const profiles = new AccountProfiles([
        {
          id: 'fixture',
          label: 'Fixture',
          provider: 'openai',
          credentialRef: { provider: 'keychain', service: 'none', account: 'none' },
          sandboxProvider: 'offline',
          sandboxProviderId: 'offline',
          models: [{ id: account.model, label: 'Offline' }],
        },
      ]);
      const runtime = createSymposiumSessionRuntime({
        sessionId,
        store: events,
        profiles,
        hostGrants: { verifySeat: () => {} },
        codexStore: {} as never,
        resolveProviderIdentity: () => ({
          name: 'offline',
          id: 'offline',
          type: 'openai',
          workspace,
        }),
        runtimeConfig,
        perSeatSandboxVerified: true,
        readOnlyEnforced: { openaiApi: true, claudeVertex: false },
        recordAccepted: () => true,
        attemptRegistry: native.registry,
        artifactLeaseHost: leaseHost,
        artifactRequest: () => leaseRequest,
        managerFactory,
      });
      sealer = new PhysicalArtifactSealer({
        store: events,
        leaseHost,
        gateway: gateway as never,
        attemptRegistry: native.registry,
        runtimeConfig,
      });
      const seal = await sealer.seal(
        {
          sessionId,
          expectedConfigRevision: 1,
          idempotencyKey: 'physical-writer-seal',
          repositoryPath: '.',
        },
        runtime,
        new AbortController().signal,
      );
      expect(seal.kind).toBe('completed_artifact_seal');
      expect(seal.git.commit).toBe(writerCommit);
      expect(events.getSymposiumSeatSandbox(sessionId, 'writer', 1)?.state).toBe('stopped');
      expect(absent(sandboxId)).toBe(true);
      expect(await sealer.requireCompleted(seal.fenceId, new AbortController().signal)).toEqual(
        seal,
      );
      const check = await sealer.checkCompletedArtifactFile(
        { fenceId: seal.fenceId, operationId: 'physical-criterion', path: 'criterion.txt' },
        new AbortController().signal,
      );
      expect(check.observedSha256).toBe(
        createHash('sha256').update('SEALED_NATIVE\n').digest('hex'),
      );
      await command(['volume', 'rm', mapping.volumeName]);
      completed = true;
      writeFileSync(
        join(root, 'evidence.json'),
        JSON.stringify(
          {
            completed,
            seal,
            check,
            controller,
            writerCommit,
            sandboxId,
            sandboxName,
            volumeName: mapping.volumeName,
            cleanupComplete: true,
            modelCalls: 0,
            fixtureAuthority: [
              'gateway inventory and absence simulated from Podman inspect',
              'provider identity and runtime account offline fixture',
            ],
            untested: [
              'live provider completion',
              'owned OpenShell gateway custody',
              'reviewer transition',
              'publication',
            ],
          },
          null,
          2,
        ),
      );
      console.log(`Physical owned-seal evidence: ${root}/evidence.json`);
    } finally {
      vi.restoreAllMocks();
      sealer?.close();
      native.registry.close();
      events.close();
      leaseHost.close();
      artifacts.close();
      if (!completed) {
        writeFileSync(
          join(root, 'retained.json'),
          JSON.stringify({ volumes, sandboxId, completed: false }, null, 2),
        );
        console.error(`Retained owned-seal physical fixture: ${root}`);
      }
    }
  },
  240_000,
);

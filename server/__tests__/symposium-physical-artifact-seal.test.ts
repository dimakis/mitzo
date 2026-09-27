import { artifactVolumeLabels } from '../symposium-session-artifacts.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountBindingSchema, type SeatConfig, type SymposiumConfig } from '@mitzo/protocol';
import { AccountProfiles } from '../account-profiles.js';
import { EventStore } from '../event-store.js';
const profiles = new AccountProfiles([
  {
    id: 'work-api',
    label: 'Work OpenAI',
    provider: 'openai',
    credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
    sandboxProvider: 'openai-work',
    sandboxProviderId: 'openai-object',
    models: [{ id: 'gpt-test', label: 'Test' }],
  },
  {
    id: 'work-vertex',
    label: 'Work Claude',
    provider: 'anthropic-vertex',
    projectId: 'work-project',
    region: 'us-east5',
    credentialRef: '/host/adc.json',
    sandboxProvider: 'vertex-work',
    sandboxProviderId: 'vertex-object',
    models: [{ id: 'claude-test', label: 'Test' }],
  },
]);
const seat = {
  id: 'reviewer',
  name: 'Reviewer',
  role: 'reviewer',
  model: 'gpt-test',
  systemPrompt: 'Review only.',
  color: '#223344',
  accountBinding: AccountBindingSchema.parse(profiles.resolve('work-api', 'gpt-test')),
  profileBinding: { profileId: 'reviewer', profileRevision: 'p1' },
  contextGrant: {
    grantId: 'context',
    revision: 1,
    classification: 'work' as const,
    sourceRefs: [],
  },
  authorityGrant: {
    grantId: 'authority',
    revision: 1,
    filesystem: 'read' as const,
    tools: 'read' as const,
    network: 'restricted' as const,
  },
  isolationRequest: {
    trustDomainId: 'shared',
    revision: 1,
    placement: 'reuse-compatible' as const,
  },
} satisfies SeatConfig;
const config: SymposiumConfig = {
  version: 2,
  revision: 4,
  state: 'active',
  anchorSeatId: 'reviewer',
  activeSeatCap: 3,
  seats: [seat],
  turnRules: { mode: 'directed', maxTurns: 10 },
  interceptMode: 'manual',
};

import { SqliteArtifactLeaseHost } from '../symposium-artifact-host.js';
import type { ArtifactLeaseRequest } from '../symposium-artifact-lease.js';

import Database from 'better-sqlite3';
import { PhysicalArtifactSealer } from '../symposium-physical-artifact-seal.js';
import { ArtifactPodmanContext } from '../symposium-artifact-host.js';
import { createSymposiumSessionRuntime } from '../symposium-session-runtime.js';
import { initializeSymposiumNativeHost } from '../symposium-native-host.js';
import { OpenShellRuntimeManager, sandboxNameForConversation } from '../openshell-runtime.js';
import { TESTED_SYMPOSIUM_NATIVE_BUILD } from '../symposium-production-gate.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from '../symposium-artifact-lease.js';
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) fn();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'physical-seal-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new EventStore(join(root, 'events.db'));
  cleanups.push(() => store.close());
  const writerConfig = {
    ...config,
    seats: [
      {
        ...seat,
        role: 'implementer' as const,
        authorityGrant: {
          ...seat.authorityGrant,
          filesystem: 'write' as const,
          tools: 'write' as const,
        },
      },
    ],
  };
  store.upsertSession({ sessionId: 'symposium', accountBinding: seat.accountBinding });
  store.setSymposiumConfig('symposium', writerConfig);
  const raw = new Database(join(root, 'events.db'));
  raw
    .prepare(
      "INSERT INTO symposium_membership(session_id,seat_id,generation,state,action,config_revision,binding_key,actor,reason,idempotency_key,occurred_at) VALUES ('symposium','reviewer',1,'active','admit',4,'binding','director','test','membership',1)",
    )
    .run();
  raw
    .prepare(
      "INSERT INTO symposium_membership_reconciliation VALUES ('symposium','reviewer',1,'confirmed')",
    )
    .run();
  raw.close();
  const record = {
    sessionId: 'symposium',
    seatId: 'reviewer',
    generation: 1,
    runtimeId: 'runtime',
    workspace: 'workspace',
    providerName: 'openai-work',
    providerId: 'openai-object',
    providerType: 'openai',
    model: 'gpt-test',
  };
  const sandboxName = sandboxNameForConversation('runtime', 13);
  const physicalId = 'physical-writer';
  store.reserveSymposiumSeatSandbox(record);
  store.markSymposiumSeatSandboxCreationStarted(record);
  store.confirmSymposiumSeatSandbox({ ...record, sandboxName, physicalId });
  store.markSymposiumSeatSandboxCreationCompleted({ ...record, physicalId });
  let phase = 'Ready';
  let verifierExists = false;
  const verifierId = 'd'.repeat(64);
  const state = { failCreate: false, failDelete: false, extraMount: false, uncertain: false };
  const gateway = {
    workspace: 'workspace',
    stateDirectory: join(root, 'gateway-first'),
    verifyCustodyAsync: vi.fn(async () => {}),
  };
  const command = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'volume')
      return JSON.stringify([
        {
          Name: 'volume',
          Driver: 'local',
          Options: {},
          Labels: artifactVolumeLabels('workspace', {
            sessionId: 'symposium',
            volumeName: 'volume',
            volumeGeneration: 'generation',
          }),
        },
      ]);
    if (args[0] === 'ps')
      return JSON.stringify(
        verifierExists ? [{ Id: verifierId }] : state.extraMount ? [{ Id: 'e'.repeat(64) }] : [],
      );
    if (args[0] === 'inspect')
      return JSON.stringify([
        {
          Id: args[1],
          ImageName: TESTED_SYMPOSIUM_NATIVE_BUILD.image,
          Config: { User: 'sandbox' },
          HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false },
          State: { Running: false, ExitCode: 0 },
          Mounts: [
            {
              Type: 'volume',
              Name: 'volume',
              Destination: SYMPOSIUM_ARTIFACT_TARGET,
              RW: state.extraMount,
            },
          ],
        },
      ]);
    if (args[0] === 'create') {
      if (state.failCreate) throw new Error('create uncertain');
      verifierExists = true;
      return verifierId;
    }
    if (args[0] === 'start')
      return JSON.stringify({
        version: 1,
        commit: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        entries: 1,
        bytes: 5,
        manifestDigest: 'c'.repeat(64),
        committedTreeDigest: 'f'.repeat(64),
      });
    if (args[0] === 'rm') {
      if (state.failDelete) throw new Error('delete uncertain');
      verifierExists = false;
      return '';
    }
    throw new Error('unexpected command');
  });
  const evidence = {
    verifyGateway: async () => {},
    verifyMount: async () => {},
    verifyDeleted: async () => {
      if (phase !== 'Absent') throw new Error('writer remains');
    },
  };
  const host = new SqliteArtifactLeaseHost(
    join(root, 'leases.db'),
    evidence,
    new ArtifactPodmanContext(command),
    gateway as never,
  );
  cleanups.push(() => host.close());
  const request: ArtifactLeaseRequest = {
    sessionId: 'symposium',
    workspaceId: 'workspace',
    seatId: 'reviewer',
    volumeName: 'volume',
    volumeGeneration: 'generation',
    driver: 'podman',
    access: 'writer',
  };
  const lease = await host.reserve(request);
  host.markCreationStarted(lease.token, lease.revision, sandboxName);
  host.bindSandbox(lease.token, lease.revision, sandboxName, physicalId);
  const native = initializeSymposiumNativeHost(join(root, 'attempts'));
  cleanups.push(() => native.registry.close());
  const runtimeConfig = {
    cli: 'openshell',
    cliContract: 'v0.1' as const,
    image: 'image',
    policy: '/policy',
    seed: '/seed',
    serviceProviders: [],
    grantableServiceProviders: [],
    workspace: 'workspace',
    gateway: 'gateway',
    gatewayInsecure: false,
    createDetached: true,
    sandboxIdLength: 13,
    workdir: '/sandbox/workspaces/mgmt',
    webSearch: 'disabled' as const,
  };
  const runtime = createSymposiumSessionRuntime({
    sessionId: 'symposium',
    store,
    profiles,
    hostGrants: { verifySeat: () => {} },
    codexStore: {} as never,
    resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'workspace' }),
    runtimeConfig,
    perSeatSandboxVerified: true,
    readOnlyEnforced: { openaiApi: true, claudeVertex: false },
    recordAccepted: () => true,
    attemptRegistry: native.registry,
    artifactLeaseHost: host,
    artifactRequest: () => request,
    managerFactory: () =>
      ({
        inspect: async () =>
          phase === 'Absent' ? null : { phase, id: physicalId, name: sandboxName },
        inspectReserved: async () =>
          phase === 'Absent' ? null : { phase, id: physicalId, name: sandboxName },
        stop: async () => {
          phase = 'Stopped';
        },
        delete: async () => {
          phase = 'Absent';
        },
      }) as never,
  });
  vi.spyOn(OpenShellRuntimeManager.prototype, 'inspectReserved').mockImplementation(async () =>
    phase === 'Absent' ? null : ({ phase, id: physicalId, name: sandboxName } as never),
  );
  const deps = {
    store,
    leaseHost: host,
    gateway: gateway as never,
    attemptRegistry: native.registry,
    runtimeConfig,
  };
  const sealer = new PhysicalArtifactSealer(deps);
  cleanups.push(() => sealer.close());
  const input = {
    sessionId: 'symposium',
    expectedConfigRevision: 4,
    idempotencyKey: 'seal',
    repositoryPath: '.',
  };
  return { store, host, native, sealer, runtime, input, state, command, root, deps };
}
it('drains the anchor through the real runtime and commits only after exact verifier cleanup', async () => {
  const f = await fixture();
  const receipt = await f.sealer.seal(f.input, f.runtime, new AbortController().signal);
  expect(receipt.kind).toBe('completed_artifact_seal');
  expect(await f.sealer.requireCompleted(receipt.fenceId, new AbortController().signal)).toEqual(
    receipt,
  );
  Object.assign(f.deps.gateway, { stateDirectory: 'another-launch' });
  await expect(
    f.sealer.requireCompleted(receipt.fenceId, new AbortController().signal),
  ).rejects.toThrow(/custody/);
  expect(f.store.getSymposiumSeatSandbox('symposium', 'reviewer', 1)?.state).toBe('stopped');
  expect(() => f.store.assertSymposiumArtifactWorkAllowed('symposium')).toThrow(/fenced/);
  await expect(
    f.host.reserve({
      sessionId: 'other',
      workspaceId: 'workspace',
      seatId: 'writer',
      volumeName: 'volume',
      volumeGeneration: 'generation',
      driver: 'podman',
      access: 'writer',
    }),
  ).rejects.toThrow(/retention/);
  expect(f.command.mock.calls.find(([args]) => args[0] === 'create')?.[0]).toEqual(
    expect.arrayContaining(['--network=none', '--read-only', '--pull=never']),
  );
});
it.each(['failCreate', 'failDelete', 'extraMount'] as const)(
  'retains pending state on %s and never publishes a receipt',
  async (failure) => {
    const f = await fixture();
    f.state[failure] = true;
    await expect(f.sealer.seal(f.input, f.runtime, new AbortController().signal)).rejects.toThrow();
    const db = new Database(join(f.root, 'leases.db'));
    expect(db.prepare('SELECT receipt_json FROM symposium_physical_seal_jobs').get()).toMatchObject(
      { receipt_json: null },
    );
    db.close();
    expect(() => f.store.assertSymposiumArtifactWorkAllowed('symposium')).toThrow(/fenced/);
  },
);
it('rejects an invented runtime capability before physical verifier dispatch', async () => {
  const f = await fixture();
  await expect(f.sealer.seal(f.input, {}, new AbortController().signal)).rejects.toThrow(
    /runtime custody/,
  );
  expect(f.command.mock.calls.some(([args]) => args[0] === 'create')).toBe(false);
});

it('retains an uncertain verifier create journal across database reopen without a completion receipt', async () => {
  const f = await fixture();
  f.state.failCreate = true;
  await expect(f.sealer.seal(f.input, f.runtime, new AbortController().signal)).rejects.toThrow(
    /uncertain/,
  );
  const intent = f.store.getSymposiumArtifactSealIntent('symposium')!;
  const reopened = new PhysicalArtifactSealer(f.deps);
  cleanups.push(() => reopened.close());
  await expect(
    reopened.requireCompleted(intent.fenceId, new AbortController().signal),
  ).rejects.toThrow(/unavailable/);
  const db = new Database(join(f.root, 'leases.db'));
  expect(
    db.prepare('SELECT phase,verifier_id,receipt_json FROM symposium_physical_seal_jobs').get(),
  ).toEqual({ phase: 'verifier_create_uncertain', verifier_id: null, receipt_json: null });
  db.close();
});

it('blocks a historical no-ID create even when current inventories could be empty', async () => {
  const f = await fixture();
  const db = new Database(join(f.root, 'events.db'));
  db.prepare(
    "INSERT INTO symposium_membership(session_id,seat_id,generation,state,action,config_revision,binding_key,actor,reason,idempotency_key,occurred_at) VALUES ('symposium','reviewer',0,'removed','remove',4,'old','director','test','old',0)",
  ).run();
  db.prepare(
    "INSERT INTO symposium_membership_reconciliation VALUES ('symposium','reviewer',0,'confirmed')",
  ).run();
  db.prepare(
    `INSERT INTO symposium_seat_sandboxes(session_id,seat_id,generation,runtime_id,workspace,provider_name,provider_id,provider_type,model,sandbox_name,physical_id,creation_started,creation_completed,state) SELECT session_id,seat_id,0,'historical-unknown',workspace,provider_name,provider_id,provider_type,model,NULL,NULL,1,0,'stopped' FROM symposium_seat_sandboxes LIMIT 1`,
  ).run();
  db.close();
  await expect(f.sealer.seal(f.input, f.runtime, new AbortController().signal)).rejects.toThrow(
    /uncertain prior creation/,
  );
  expect(f.command.mock.calls.some(([args]) => args[0] === 'create')).toBe(false);
  expect(() => f.store.assertSymposiumArtifactWorkAllowed('symposium')).toThrow(/fenced/);
});
it('blocks a lease with no retained sandbox generation instead of treating inventory absence as proof', async () => {
  const f = await fixture();
  await f.host.reserve({
    sessionId: 'symposium',
    workspaceId: 'workspace',
    seatId: 'orphan',
    volumeName: 'volume',
    volumeGeneration: 'generation',
    driver: 'podman',
    access: 'reviewer',
  });
  await expect(f.sealer.seal(f.input, f.runtime, new AbortController().signal)).rejects.toThrow(
    /orphan or uncertain/,
  );
  expect(f.command.mock.calls.some(([args]) => args[0] === 'create')).toBe(false);
});

import { createHash } from 'node:crypto';
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
import { ArtifactPodmanContext, ArtifactCommandNotDispatched } from '../symposium-artifact-host.js';
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
async function fixture(inspectionPaths = ['file']) {
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
  let helperId = verifierId;
  let exportJob: string | undefined;
  let exportOptions: Record<string, unknown> | undefined;
  const proof = {
    version: 1,
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    entries: 1,
    bytes: 5,
    manifestDigest: 'c'.repeat(64),
    committedTreeDigest: 'f'.repeat(64),
  };
  const state = { failCreate: false, failDelete: false, extraMount: false, uncertain: false };
  const gateway = {
    workspace: 'workspace',
    stateDirectory: join(root, 'gateway-first'),
    verifyCustodyAsync: vi.fn(async () => {}),
  };
  const command = vi.fn(async (args: readonly string[], _maxOutputBytes?: number) => {
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
        verifierExists ? [{ Id: helperId }] : state.extraMount ? [{ Id: 'e'.repeat(64) }] : [],
      );
    if (args[0] === 'inspect')
      return JSON.stringify([
        {
          Id: args[1],
          ImageName: TESTED_SYMPOSIUM_NATIVE_BUILD.image,
          Config: {
            User: 'sandbox',
            Labels: exportJob ? { 'mitzo.artifact-export-job': exportJob } : {},
          },
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
      if (args.includes('--label')) {
        exportJob = args[args.indexOf('--label') + 1].split('=')[1];
        exportOptions = JSON.parse(args.at(-1)!);
        helperId = 'e'.repeat(64);
      } else {
        helperId = verifierId;
        exportOptions = undefined;
        exportJob = undefined;
      }
      return helperId;
    }
    if (args[0] === 'start') {
      if (exportOptions?.kind === 'inspect')
        return JSON.stringify({
          proof,
          inspection: {
            canonicalRepositoryPath: SYMPOSIUM_ARTIFACT_TARGET,
            status: 'clean',
            sourceBranch: 'feature',
            sourceOid: proof.commit,
            defaultBranch: 'main',
            originUrl: 'https://github.com/example/repo',
            commitsAhead: 1,
            changedFiles: inspectionPaths,
            sourceBranchProtected: false,
            symlinkFree: true,
          },
        });
      if (exportOptions?.kind === 'bundle' || exportOptions?.kind === 'successor') {
        const bundle = Buffer.from('synthetic bounded bundle');
        return JSON.stringify({
          proof,
          selection: {
            sourceRef: 'refs/heads/feature',
            sourceOid: proof.commit,
            baseRef: 'refs/remotes/origin/main',
            baseOid: 'b'.repeat(40),
            defaultBranch: 'main',
            originUrl: 'https://github.com/example/repo',
          },
          bundle: bundle.toString('base64'),
          bytes: bundle.length,
          bundleSha256: createHash('sha256').update(bundle).digest('hex'),
        });
      }
      return JSON.stringify(proof);
    }
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
          phase === 'Absent' ? undefined : { phase, id: physicalId, name: sandboxName },
        inspectReserved: async () =>
          phase === 'Absent' ? undefined : { phase, id: physicalId, name: sandboxName },
        stop: async () => {
          phase = 'Stopped';
        },
        delete: async () => {
          phase = 'Absent';
        },
      }) as never,
  });
  vi.spyOn(OpenShellRuntimeManager.prototype, 'inspectReserved').mockImplementation(async () =>
    phase === 'Absent' ? undefined : ({ phase, id: physicalId, name: sandboxName } as never),
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
  return { store, host, native, sealer, runtime, input, state, command, root, deps, gateway };
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
it('rejects invented runtime custody without changing any ledger or fencing work', async () => {
  const f = await fixture();
  const snapshot = () =>
    ['events.db', 'leases.db'].map((file) => {
      const db = new Database(join(f.root, file));
      try {
        return (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
            name: string;
          }[]
        ).map(({ name }) => [
          name,
          db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all(),
        ]);
      } finally {
        db.close();
      }
    });
  const before = snapshot();
  await expect(f.sealer.seal(f.input, {}, new AbortController().signal)).rejects.toThrow(
    /runtime custody/,
  );
  expect(f.command.mock.calls.some(([args]) => args[0] === 'create')).toBe(false);
  expect(snapshot()).toEqual(before);
  expect(() => f.store.assertSymposiumArtifactWorkAllowed('symposium')).not.toThrow();
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

it('exports only through a fresh completed seal and retains exact helper cleanup records', async () => {
  const f = await fixture();
  const receipt = await f.sealer.seal(f.input, f.runtime, new AbortController().signal);
  const selected = { fenceId: receipt.fenceId, operationId: 'publication-1', baseBranch: 'main' };
  expect(
    await f.sealer.inspectCompletedArtifact(selected, new AbortController().signal),
  ).toMatchObject({ sourceOid: receipt.git.commit, status: 'clean' });
  expect(
    (
      await f.sealer.exportCompletedArtifactBundle(
        { ...selected, sourceBranch: 'feature', sourceOid: receipt.git.commit, maxBytes: 1024 },
        new AbortController().signal,
      )
    ).toString(),
  ).toBe('synthetic bounded bundle');
  const db = new Database(join(f.root, 'leases.db'));
  expect(db.prepare('SELECT state,container_id FROM symposium_seal_export_jobs').all()).toEqual([
    { state: 'complete', container_id: 'e'.repeat(64) },
    { state: 'complete', container_id: 'e'.repeat(64) },
  ]);
  db.close();
  expect(() => f.store.assertSymposiumArtifactWorkAllowed('symposium')).toThrow(/fenced/);
});
it('retains uncertain export create intent and blocks another export without blind retry', async () => {
  const f = await fixture();
  const receipt = await f.sealer.seal(f.input, f.runtime, new AbortController().signal);
  f.state.failCreate = true;
  const input = { fenceId: receipt.fenceId, operationId: 'publication-1', baseBranch: 'main' };
  await expect(
    f.sealer.inspectCompletedArtifact(input, new AbortController().signal),
  ).rejects.toThrow(/export failed/);
  f.state.failCreate = false;
  await expect(
    f.sealer.inspectCompletedArtifact(input, new AbortController().signal),
  ).rejects.toThrow(/helper reconciliation/);
  const db = new Database(join(f.root, 'leases.db'));
  expect(db.prepare('SELECT state,container_id FROM symposium_seal_export_jobs').get()).toEqual({
    state: 'create_uncertain',
    container_id: null,
  });
  db.close();
});
it('never returns a bundle if exact helper cleanup is uncertain', async () => {
  const f = await fixture();
  const receipt = await f.sealer.seal(f.input, f.runtime, new AbortController().signal);
  f.state.failDelete = true;
  await expect(
    f.sealer.exportCompletedArtifactBundle(
      {
        fenceId: receipt.fenceId,
        operationId: 'publication-1',
        baseBranch: 'main',
        sourceBranch: 'feature',
        sourceOid: receipt.git.commit,
        maxBytes: 1024,
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/export failed/);
  const db = new Database(join(f.root, 'leases.db'));
  expect(db.prepare('SELECT state,container_id FROM symposium_seal_export_jobs').get()).toEqual({
    state: 'terminal',
    container_id: 'e'.repeat(64),
  });
  db.close();
});

it('records confirmed deletion when final export custody revalidation fails', async () => {
  const f = await fixture();
  const receipt = await f.sealer.seal(f.input, f.runtime, new AbortController().signal);
  const requireCompleted = f.sealer.requireCompleted.bind(f.sealer);
  const check = vi.spyOn(f.sealer, 'requireCompleted');
  check
    .mockImplementationOnce(requireCompleted)
    .mockRejectedValueOnce(new Error('custody changed'));
  const input = { fenceId: receipt.fenceId, operationId: 'post-cleanup', baseBranch: 'main' };
  await expect(
    f.sealer.inspectCompletedArtifact(input, new AbortController().signal),
  ).rejects.toThrow(/export failed/);
  const db = new Database(join(f.root, 'leases.db'));
  expect(db.prepare('SELECT state,container_id FROM symposium_seal_export_jobs').get()).toEqual({
    state: 'failed_cleaned',
    container_id: 'e'.repeat(64),
  });
  db.close();
  check.mockRestore();
  await expect(
    f.sealer.inspectCompletedArtifact(input, new AbortController().signal),
  ).resolves.toMatchObject({ sourceOid: receipt.git.commit });
});

it('transports permitted long Unicode inspection paths above the old 128 KiB ceiling', async () => {
  const paths = Array.from({ length: 499 }, (_, i) => `${'é'.repeat(180)}/${i}`);
  const f = await fixture(paths);
  const receipt = await f.sealer.seal(f.input, f.runtime, new AbortController().signal);
  const inspection = await f.sealer.inspectCompletedArtifact(
    { fenceId: receipt.fenceId, operationId: 'large-inspection', baseBranch: 'main' },
    new AbortController().signal,
  );
  expect(inspection.changedFiles).toEqual(paths);
  expect(f.command.mock.calls.filter(([args]) => args[0] === 'start').at(-1)?.[1]).toBeGreaterThan(
    Buffer.byteLength(JSON.stringify(inspection)),
  );
});

it.each(['abort', 'custody'] as const)(
  'does not journal dispatch after known predispatch %s failure',
  async (failure) => {
    const f = await fixture();
    const receipt = await f.sealer.seal(f.input, f.runtime, new AbortController().signal);
    const controller = new AbortController();
    const requireCompleted = f.sealer.requireCompleted.bind(f.sealer);
    const check = vi.spyOn(f.sealer, 'requireCompleted').mockImplementationOnce(async (...args) => {
      const completed = await requireCompleted(...args);
      if (failure === 'abort') controller.abort();
      else f.gateway.verifyCustodyAsync.mockRejectedValueOnce(new Error('custody changed'));
      return completed;
    });
    f.command.mockClear();
    const selected = { fenceId: receipt.fenceId, operationId: 'predispatch', baseBranch: 'main' };
    await expect(f.sealer.inspectCompletedArtifact(selected, controller.signal)).rejects.toThrow();
    expect(f.command.mock.calls.some(([args]) => args[0] === 'create')).toBe(false);
    const db = new Database(join(f.root, 'leases.db'));
    expect(db.prepare('SELECT * FROM symposium_seal_export_jobs').all()).toEqual([]);
    db.close();
    check.mockRestore();
    await expect(
      f.sealer.inspectCompletedArtifact(selected, new AbortController().signal),
    ).resolves.toMatchObject({ status: 'clean' });
  },
);

it('retains successful verifier removal before later custody failure without completing', async () => {
  const f = await fixture();
  const command = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (...args) => {
    const result = await command(...args);
    if (args[0][0] === 'rm')
      f.gateway.verifyCustodyAsync.mockRejectedValue(new Error('custody lost'));
    return result;
  });
  await expect(f.sealer.seal(f.input, f.runtime, new AbortController().signal)).rejects.toThrow(
    'custody lost',
  );
  const db = new Database(join(f.root, 'leases.db'));
  expect(db.prepare('SELECT phase,receipt_json FROM symposium_physical_seal_jobs').get()).toEqual({
    phase: 'verifier_removed',
    receipt_json: null,
  });
  db.close();
});

it('retains exact export removal observation when the absence census fails without retrying removal', async () => {
  const f = await fixture();
  const receipt = await f.sealer.seal(f.input, f.runtime, new AbortController().signal);
  const command = f.command.getMockImplementation()!;
  let removed = false;
  f.command.mockClear();
  f.command.mockImplementation(async (...args) => {
    if (removed && args[0][0] === 'ps') throw new Error('census unavailable');
    const result = await command(...args);
    if (args[0][0] === 'rm') removed = true;
    return result;
  });
  await expect(
    f.sealer.inspectCompletedArtifact(
      { fenceId: receipt.fenceId, operationId: 'removal-observed', baseBranch: 'main' },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  const db = new Database(join(f.root, 'leases.db'));
  expect(
    db.prepare('SELECT state,container_id,result_hash FROM symposium_seal_export_jobs').get(),
  ).toEqual({ state: 'removed', container_id: 'e'.repeat(64), result_hash: null });
  db.close();
  expect(f.command.mock.calls.filter(([args]) => args[0] === 'rm')).toHaveLength(1);
});

it('records known transport predispatch rejection without clearing real dispatch uncertainty', async () => {
  const f = await fixture();
  const receipt = await f.sealer.seal(f.input, f.runtime, new AbortController().signal);
  const command = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (...args) => {
    if (args[0][0] === 'create') throw new ArtifactCommandNotDispatched();
    return command(...args);
  });
  const selected = {
    fenceId: receipt.fenceId,
    operationId: 'transport-predispatch',
    baseBranch: 'main',
  };
  await expect(
    f.sealer.inspectCompletedArtifact(selected, new AbortController().signal),
  ).rejects.toThrow();
  const db = new Database(join(f.root, 'leases.db'));
  expect(db.prepare('SELECT state,container_id FROM symposium_seal_export_jobs').get()).toEqual({
    state: 'not_dispatched',
    container_id: null,
  });
  db.close();
  f.command.mockImplementation(command);
  await expect(
    f.sealer.inspectCompletedArtifact(selected, new AbortController().signal),
  ).resolves.toMatchObject({ status: 'clean' });
});

it('retains exact successor export authority across reopen and rejects substituted evidence', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  const exported = await f.sealer.exportSuccessorArtifactBundle(
    {
      fenceId: seal.fenceId,
      operationId: 'fix-copy-1',
      baseBranch: 'main',
      sourceBranch: 'feature',
      sourceOid: seal.git.commit,
      maxBytes: 1024,
    },
    signal,
  );
  expect(exported.receipt).toMatchObject({
    version: 1,
    mode: 'successor',
    operationId: 'fix-copy-1',
    seal,
    bundleSha256: createHash('sha256').update(exported.bundle).digest('hex'),
    bytes: exported.bundle.length,
    helper: { id: 'e'.repeat(64), terminalExitCode: 0, removed: true },
    selection: {
      sourceRef: 'refs/heads/feature',
      sourceOid: seal.git.commit,
      baseRef: 'refs/remotes/origin/main',
    },
  });
  const reopened = new PhysicalArtifactSealer(f.deps);
  cleanups.push(() => reopened.close());
  await expect(
    reopened.requireSuccessorExport(exported.receipt, exported.bundle, signal),
  ).resolves.toEqual(seal);
  for (const patch of [
    { operationId: 'other' },
    { parentGenerationId: 'other' },
    { mode: 'bundle' },
    { helper: { ...exported.receipt.helper, removed: false } },
  ]) {
    await expect(
      reopened.requireSuccessorExport(
        { ...exported.receipt, ...patch } as typeof exported.receipt,
        exported.bundle,
        signal,
      ),
    ).rejects.toThrow();
  }
  await expect(
    reopened.requireSuccessorExport(exported.receipt, Buffer.from('substitute'), signal),
  ).rejects.toThrow();
  const db = new Database(join(f.root, 'leases.db'));
  db.prepare("UPDATE symposium_seal_export_jobs SET state='removed' WHERE job_id=?").run(
    exported.receipt.jobId,
  );
  await expect(
    reopened.requireSuccessorExport(exported.receipt, exported.bundle, signal),
  ).rejects.toThrow();
  db.close();
});

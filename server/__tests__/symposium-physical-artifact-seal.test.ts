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
import { canonicalReviewJson } from '../symposium-review-records.js';
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) fn();
});
async function fixture(inspectionPaths = ['file'], streaming = true) {
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
  const state = {
    failCreate: false,
    failDelete: false,
    extraMount: false,
    uncertain: false,
    crowdCount: 0,
    streamIncomplete: false,
    streamPages: 2,
    streamHold: undefined as Promise<void> | undefined,
    censusTamper: 'none' as 'none' | 'missing' | 'duplicate' | 'foreign' | 'malformed',
  };
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
    if (args[0] === 'ps') {
      const present = verifierExists
        ? [{ Id: helperId, Names: 'fixture-helper' }]
        : state.extraMount
          ? [{ Id: 'e'.repeat(64), Names: 'fixture-extra' }]
          : [];
      return JSON.stringify([
        ...present,
        ...Array.from({ length: state.crowdCount }, (_, i) => ({
          Id: (i + 1).toString(16).padStart(64, '0'),
          Names: `unrelated-${i}`,
        })),
      ]);
    }
    if (args[0] === 'inspect') {
      const ids = args[1] === '--type' ? args.slice(3) : args.slice(1);
      const inspected = ids.map((id) => ({
        Id: id,
        ImageName: TESTED_SYMPOSIUM_NATIVE_BUILD.image,
        Config: {
          User: 'sandbox',
          Labels: exportJob ? { 'mitzo.artifact-export-job': exportJob } : {},
        },
        HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false },
        State: { Running: false, ExitCode: 0 },
        Mounts:
          id === helperId || id === 'e'.repeat(64)
            ? [
                {
                  Type: 'volume',
                  Name: 'volume',
                  Destination: SYMPOSIUM_ARTIFACT_TARGET,
                  RW: state.extraMount && id === 'e'.repeat(64),
                },
              ]
            : [],
      }));
      if (args[1] === '--type') {
        if (state.censusTamper === 'missing') inspected.pop();
        if (state.censusTamper === 'duplicate' && inspected.length > 1)
          inspected[1].Id = inspected[0].Id;
        if (state.censusTamper === 'foreign') inspected[0].Id = 'f'.repeat(64);
        if (state.censusTamper === 'malformed')
          inspected[0].Mounts = [{ Type: 'volume', Name: 'volume' }] as never;
      }
      return JSON.stringify(inspected);
    }
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
      if (exportOptions?.kind === 'check')
        return JSON.stringify({
          proof,
          checkPath: exportOptions.checkPath,
          observedSha256: createHash('sha256').update('hello').digest('hex'),
        });
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
      if (exportOptions?.kind === 'review_context') {
        const fileHash = createHash('sha256').update('hello').digest('hex');
        if (exportOptions.page === 0) {
          const identity = {
            version: 3,
            scope: 'sealed-changed-path-pages',
            sourceOid: proof.commit,
            baseOid: 'b'.repeat(40),
            sourceBranch: 'feature',
            baseBranch: 'main',
            committedTreeDigest: proof.committedTreeDigest,
            manifestDigest: proof.manifestDigest,
            trackedFileCount: proof.entries,
            changedPathCount: 1,
            evidenceSha256: 'd'.repeat(64),
            pageCount: 2,
          };
          const pages = ['he', 'llo'].map((data, pageIndex) =>
            canonicalReviewJson({
              ...identity,
              pageIndex,
              segments: [
                {
                  path: 'marker.txt',
                  status: 'present',
                  baseMode: null,
                  mode: '100644',
                  sha256: fileHash,
                  bytes: 5,
                  representation: 'content',
                  diffSha256: createHash('sha256').update('diff').digest('hex'),
                  diffBytes: 4,
                  selectedSha256: fileHash,
                  selectedBytes: 5,
                  segmentIndex: pageIndex,
                  segmentCount: 2,
                  data,
                  segmentSha256: createHash('sha256').update(data).digest('hex'),
                },
              ],
            }),
          );
          return JSON.stringify({
            proof,
            context: pages[0],
            contextSha256: createHash('sha256').update(pages[0]).digest('hex'),
            pages,
            pagesSha256: createHash('sha256').update(canonicalReviewJson(pages)).digest('hex'),
          });
        }
        const context = canonicalReviewJson({
          version: 2,
          scope: 'bounded-changed-path-evidence',
          sourceOid: proof.commit,
          baseOid: 'b'.repeat(40),
          sourceBranch: 'feature',
          baseBranch: 'main',
          committedTreeDigest: proof.committedTreeDigest,
          manifestDigest: proof.manifestDigest,
          trackedFileCount: proof.entries,
          changedPathCount: 1,
          omittedPathCount: 0,
          files: [
            {
              path: 'marker.txt',
              status: 'present',
              baseMode: null,
              mode: '100644',
              bytes: 5,
              sha256: fileHash,
              representation: 'content',
              complete: true,
              content: 'hello',
              contentTruncated: false,
              diff: null,
              diffSha256: createHash('sha256')
                .update('diff --git a/marker.txt b/marker.txt\n+hello\n')
                .digest('hex'),
              diffBytes: Buffer.byteLength('diff --git a/marker.txt b/marker.txt\n+hello\n'),
              diffTruncated: false,
            },
          ],
        });
        return JSON.stringify({
          proof,
          context,
          contextSha256: createHash('sha256').update(context).digest('hex'),
        });
      }
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
  const stream = async (args: readonly string[], onChunk: (chunk: Buffer) => void) => {
    if (exportOptions?.kind !== 'review_stream') throw new Error('Unexpected stream');
    await state.streamHold;
    const current = exportOptions;
    exportOptions = { ...current, kind: 'review_context', page: 0 };
    const result = JSON.parse(await command(args));
    exportOptions = current;
    const baseContexts = result.pages as string[];
    const contexts = Array.from({ length: state.streamPages }, (_, pageIndex) =>
      canonicalReviewJson({
        ...JSON.parse(baseContexts[pageIndex % baseContexts.length]),
        pageIndex,
        pageCount: state.streamPages,
      }),
    );
    const header = {
      proof,
      pageCount: contexts.length,
      evidenceSha256: 'd'.repeat(64),
      sourceOid: proof.commit,
      baseOid: 'b'.repeat(40),
    };
    onChunk(Buffer.from(`H${canonicalReviewJson(header)}\n`));
    for (const context of contexts) onChunk(Buffer.from(`P${context}\n`));
    if (!state.streamIncomplete)
      onChunk(
        Buffer.from(
          `F${canonicalReviewJson({
            proof,
            pageCount: contexts.length,
            evidenceSha256: header.evidenceSha256,
            pagesSha256: createHash('sha256').update(canonicalReviewJson(contexts)).digest('hex'),
          })}\n`,
        ),
      );
  };
  const host = new SqliteArtifactLeaseHost(
    join(root, 'leases.db'),
    evidence,
    new ArtifactPodmanContext(command, command, streaming ? stream : undefined),
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
it('seals with eighty unrelated containers through bounded bulk inspection', async () => {
  const f = await fixture();
  f.state.crowdCount = 80;
  const receipt = await f.sealer.seal(f.input, f.runtime, new AbortController().signal);
  expect(receipt.kind).toBe('completed_artifact_seal');
  const bulk = f.command.mock.calls.filter(
    ([args]) => args[0] === 'inspect' && args[1] === '--type',
  );
  expect(bulk.length).toBeGreaterThan(0);
  expect(bulk.some(([args]) => args.length === 83)).toBe(true);
  expect(bulk.every(([, maxBytes]) => maxBytes === 12 * 1024 * 1024)).toBe(true);
  expect(f.command.mock.calls.some(([args]) => args[0] === 'inspect' && args.length === 2)).toBe(
    true,
  );
});

it.each(['missing', 'duplicate', 'foreign', 'malformed'] as const)(
  'fails closed when bulk inspection is %s',
  async (kind) => {
    const f = await fixture();
    f.state.crowdCount = 80;
    f.state.censusTamper = kind;
    await expect(f.sealer.seal(f.input, f.runtime, new AbortController().signal)).rejects.toThrow(
      /Artifact census inspection changed|Artifact mount census is incomplete/,
    );
    expect(f.command.mock.calls.some(([args]) => args[0] === 'create')).toBe(false);
  },
);

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
it('checks one committed file through a fresh credential-free sealed helper', async () => {
  const f = await fixture();
  const seal = await f.sealer.seal(f.input, f.runtime, new AbortController().signal);
  const check = await f.sealer.checkCompletedArtifactFile(
    { fenceId: seal.fenceId, operationId: 'criterion-1', path: 'marker.txt' },
    new AbortController().signal,
  );
  expect(check).toMatchObject({
    sealFenceId: seal.fenceId,
    artifactRevision: seal.git.commit,
    artifactHash: seal.git.committedTreeDigest,
    observedSha256: createHash('sha256').update('hello').digest('hex'),
  });
  const helperCreate = f.command.mock.calls.find(
    ([args]) =>
      args[0] === 'create' && args.some((arg) => arg.includes('mitzo.artifact-export-job=')),
  );
  expect(JSON.parse(helperCreate![0].at(-1)!)).not.toHaveProperty('baseBranch');
  const db = new Database(join(f.root, 'leases.db'));
  expect(
    db.prepare('SELECT kind,state,container_id FROM symposium_seal_export_jobs').get(),
  ).toEqual({
    kind: 'check',
    state: 'complete',
    container_id: 'e'.repeat(64),
  });
  db.close();
});
it('exports a bounded physically sealed review context and permits exact same-operation recovery three times', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  const input = { fenceId: seal.fenceId, operationId: 'review-context-1', baseBranch: 'main' };
  const exports = [];
  for (let i = 0; i < 3; i++)
    exports.push(await f.sealer.exportCompletedReviewContext(input, signal));
  expect(new Set(exports.map((result) => result.receipt.contextSha256)).size).toBe(1);
  expect(exports[0].receipt).toMatchObject({
    mode: 'review_context',
    operationId: input.operationId,
    sealFenceId: seal.fenceId,
    artifactRevision: seal.git.commit,
    artifactHash: seal.git.committedTreeDigest,
    baseOid: 'b'.repeat(40),
    sourceOid: seal.git.commit,
    helper: { image: TESTED_SYMPOSIUM_NATIVE_BUILD.image, removed: true },
  });
  expect(JSON.parse(exports[0].context).files).toMatchObject([
    { path: 'marker.txt', content: 'hello' },
  ]);
  const db = new Database(join(f.root, 'leases.db'));
  expect(
    db
      .prepare(
        "SELECT state,kind,receipt_json FROM symposium_seal_export_jobs WHERE operation_id='review-context-1'",
      )
      .all(),
  ).toHaveLength(3);
  db.close();
});
it('attests every page of one bounded physical review export', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  const exported = await f.sealer.exportCompletedReviewContext(
    { fenceId: seal.fenceId, operationId: 'review-pages-1', baseBranch: 'main', page: 0 },
    signal,
  );
  expect(exported.pages).toHaveLength(2);
  expect(exported.receipt).toMatchObject({
    pageIndex: 0,
    pageCount: 2,
    evidenceSha256: 'd'.repeat(64),
  });
  expect(exported.pages!.map((page) => JSON.parse(page.context).pageIndex)).toEqual([0, 1]);
  for (const [index, page] of exported.pages!.entries()) {
    expect(page.receipt).toMatchObject({
      jobId: exported.receipt.jobId,
      pagesSha256: exported.receipt.pagesSha256,
      pageIndex: index,
      pageCount: 2,
      contextSha256: createHash('sha256').update(page.context).digest('hex'),
    });
  }
});
it('stages a complete review stream once and serves exact replay from SQLite', async () => {
  const f = await fixture(['file'], true);
  f.state.streamPages = 18;
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  const input = {
    fenceId: seal.fenceId,
    operationId: 'stream-pages-1',
    baseBranch: 'main',
    page: 0,
  };
  const first = await f.sealer.exportCompletedReviewContext(input, signal);
  const repeated = await f.sealer.exportCompletedReviewContext(input, signal);
  expect(repeated).toEqual(first);
  expect(first.pages).toHaveLength(16);
  const tail = await f.sealer.exportCompletedReviewContext(
    { ...input, operationId: 'stream-pages-1-p16', page: 16 },
    signal,
  );
  expect(tail.pages).toHaveLength(2);
  expect(tail.receipt.pagesSha256).toBe(first.receipt.pagesSha256);
  expect(
    f.command.mock.calls.filter(
      (call) =>
        call[0][0] === 'create' &&
        call[0].includes('mitzo.artifact-export-job=' + first.receipt.jobId),
    ),
  ).toHaveLength(1);
  const db = new Database(join(f.root, 'leases.db'));
  expect(db.prepare('SELECT ready FROM symposium_review_streams').get()).toEqual({ ready: 1 });
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_pages').get()).toEqual({
    count: 18,
  });
  await f.sealer.releaseCompletedReviewStream({
    fenceId: seal.fenceId,
    operationId: input.operationId,
    pagesSha256: first.receipt.pagesSha256!,
  });
  await f.sealer.releaseCompletedReviewStream({
    fenceId: seal.fenceId,
    operationId: input.operationId,
    pagesSha256: first.receipt.pagesSha256!,
  });
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_pages').get()).toEqual({
    count: 0,
  });
  expect(db.prepare('SELECT pages_sha256 FROM symposium_review_stream_tombstones').get()).toEqual({
    pages_sha256: first.receipt.pagesSha256,
  });
  const replay = await f.sealer.exportCompletedReviewContext(input, signal);
  expect(replay.receipt.pagesSha256).toBe(first.receipt.pagesSha256);
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_pages').get()).toEqual({
    count: 18,
  });
  await expect(
    f.sealer.releaseCompletedReviewStream({
      fenceId: seal.fenceId,
      operationId: input.operationId,
      pagesSha256: '0'.repeat(64),
    }),
  ).rejects.toThrow(/release changed/);
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_pages').get()).toEqual({
    count: 18,
  });
  await f.sealer.releaseCompletedReviewStream({
    fenceId: seal.fenceId,
    operationId: input.operationId,
    pagesSha256: first.receipt.pagesSha256!,
  });
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_pages').get()).toEqual({
    count: 0,
  });
  db.close();
});
it('reclaims a ready review stream after restart without renewing old seal custody', async () => {
  const f = await fixture(['file'], true);
  f.state.streamPages = 18;
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  const input = {
    fenceId: seal.fenceId,
    operationId: 'crashed-review-1',
    baseBranch: 'main',
    page: 0,
  };
  const exported = await f.sealer.exportCompletedReviewContext(input, signal);
  const db = new Database(join(f.root, 'leases.db'));
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_pages').get()).toEqual({
    count: 18,
  });
  f.sealer.close();
  Object.assign(f.gateway, { stateDirectory: join(f.root, 'gateway-restarted') });
  const restarted = new PhysicalArtifactSealer(f.deps);
  cleanups.push(() => restarted.close());
  await restarted.releaseAbandonedReadyReviewStreams();
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_pages').get()).toEqual({
    count: 0,
  });
  expect(db.prepare('SELECT pages_sha256 FROM symposium_review_stream_tombstones').get()).toEqual({
    pages_sha256: exported.receipt.pagesSha256,
  });
  await expect(restarted.requireCompleted(seal.fenceId, signal)).rejects.toThrow(/custody/);
  db.close();
});
it('reclaims an older pinned helper build after an application upgrade', async () => {
  const f = await fixture(['file'], true);
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  await f.sealer.exportCompletedReviewContext(
    { fenceId: seal.fenceId, operationId: 'older-build-review', baseBranch: 'main', page: 0 },
    signal,
  );
  const db = new Database(join(f.root, 'leases.db'));
  const original = db.prepare('SELECT receipt_json FROM symposium_review_streams').get() as {
    receipt_json: string;
  };
  const historicalImage = `sha256:${'8'.repeat(64)}`;
  const historicalCode = '9'.repeat(64);
  const historicalSeal = {
    ...seal,
    verifier: { ...seal.verifier, image: historicalImage },
  };
  const historicalSealDigest = createHash('sha256')
    .update(canonicalReviewJson(historicalSeal))
    .digest('hex');
  const receipt = {
    ...JSON.parse(original.receipt_json),
    sealDigest: historicalSealDigest,
    helper: {
      ...JSON.parse(original.receipt_json).helper,
      image: historicalImage,
      codeDigest: historicalCode,
    },
  };
  const historicalReceipt = canonicalReviewJson(receipt);
  db.prepare('UPDATE symposium_physical_seal_jobs SET receipt_json=?').run(
    JSON.stringify(historicalSeal),
  );
  db.prepare('UPDATE symposium_review_streams SET receipt_json=?,seal_digest=?').run(
    historicalReceipt,
    historicalSealDigest,
  );
  db.prepare(
    'UPDATE symposium_seal_export_jobs SET receipt_json=?,helper_image=?,export_code_digest=? WHERE kind=?',
  ).run(historicalReceipt, historicalImage, historicalCode, 'review_stream');
  f.sealer.close();
  Object.assign(f.gateway, { stateDirectory: join(f.root, 'gateway-upgraded') });
  const upgraded = new PhysicalArtifactSealer(f.deps);
  cleanups.push(() => upgraded.close());
  await upgraded.releaseAbandonedReadyReviewStreams();
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_pages').get()).toEqual({
    count: 0,
  });
  db.close();
});

it('recognizes only the frozen pre-pin legacy helper identity', async () => {
  const f = await fixture(['file'], true);
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  await f.sealer.exportCompletedReviewContext(
    { fenceId: seal.fenceId, operationId: 'legacy-build-review', baseBranch: 'main', page: 0 },
    signal,
  );
  const db = new Database(join(f.root, 'leases.db'));
  db.prepare(
    'UPDATE symposium_seal_export_jobs SET helper_image=NULL,export_code_digest=NULL,review_build_version=NULL WHERE kind=?',
  ).run('review_stream');
  f.sealer.close();
  Object.assign(f.gateway, { stateDirectory: join(f.root, 'gateway-upgraded') });
  const upgraded = new PhysicalArtifactSealer(f.deps);
  cleanups.push(() => upgraded.close());
  await upgraded.releaseAbandonedReadyReviewStreams();
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_pages').get()).toEqual({
    count: 0,
  });
  db.close();
});
it('fails closed for an unrecognized pre-pin export code identity', async () => {
  const f = await fixture(['file'], true);
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  await f.sealer.exportCompletedReviewContext(
    { fenceId: seal.fenceId, operationId: 'legacy-unknown-review', baseBranch: 'main', page: 0 },
    signal,
  );
  const db = new Database(join(f.root, 'leases.db'));
  const row = db.prepare('SELECT receipt_json FROM symposium_review_streams').get() as {
    receipt_json: string;
  };
  const receipt = JSON.parse(row.receipt_json);
  receipt.helper.codeDigest = '9'.repeat(64);
  const changed = canonicalReviewJson(receipt);
  db.prepare('UPDATE symposium_review_streams SET receipt_json=?').run(changed);
  db.prepare(
    'UPDATE symposium_seal_export_jobs SET receipt_json=?,helper_image=NULL,export_code_digest=NULL,review_build_version=NULL WHERE kind=?',
  ).run(changed, 'review_stream');
  f.sealer.close();
  Object.assign(f.gateway, { stateDirectory: join(f.root, 'gateway-upgraded') });
  const upgraded = new PhysicalArtifactSealer(f.deps);
  cleanups.push(() => upgraded.close());
  await expect(upgraded.releaseAbandonedReadyReviewStreams()).rejects.toThrow(/identity changed/);
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_pages').get()).toEqual({
    count: 2,
  });
  db.close();
});
it('releases a stopped review preparation only when its exact ready stream exists', async () => {
  const f = await fixture(['file'], true);
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  const input = {
    fenceId: seal.fenceId,
    operationId: 'stopped-review-1',
    baseBranch: 'main',
  };
  await f.sealer.releaseStoppedReadyReviewStream(input); // no export began
  const exported = await f.sealer.exportCompletedReviewContext({ ...input, page: 0 }, signal);
  const db = new Database(join(f.root, 'leases.db'));
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_pages').get()).toEqual({
    count: 2,
  });
  await f.sealer.releaseStoppedReadyReviewStream(input);
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_pages').get()).toEqual({
    count: 0,
  });
  expect(db.prepare('SELECT pages_sha256 FROM symposium_review_stream_tombstones').get()).toEqual({
    pages_sha256: exported.receipt.pagesSha256,
  });
  await f.sealer.releaseStoppedReadyReviewStream(input); // exact tombstone replay
  db.close();
});

it('keeps a corrupted historical ready stream sealed for recovery', async () => {
  const f = await fixture(['file'], true);
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  await f.sealer.exportCompletedReviewContext(
    { fenceId: seal.fenceId, operationId: 'crashed-review-bad', baseBranch: 'main', page: 0 },
    signal,
  );
  const db = new Database(join(f.root, 'leases.db'));
  db.prepare("UPDATE symposium_seal_export_jobs SET result_hash=? WHERE kind='review_stream'").run(
    '0'.repeat(64),
  );
  f.sealer.close();
  Object.assign(f.gateway, { stateDirectory: join(f.root, 'gateway-restarted') });
  const restarted = new PhysicalArtifactSealer(f.deps);
  cleanups.push(() => restarted.close());
  await expect(restarted.releaseAbandonedReadyReviewStreams()).rejects.toThrow(/identity changed/);
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_pages').get()).toEqual({
    count: 2,
  });
  expect(
    db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_tombstones').get(),
  ).toEqual({
    count: 0,
  });
  db.close();
});
it('discards incomplete staged pages after exact helper cleanup and retries', async () => {
  const f = await fixture(['file'], true);
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  const input = {
    fenceId: seal.fenceId,
    operationId: 'stream-retry-1',
    baseBranch: 'main',
    page: 0,
  };
  f.state.streamIncomplete = true;
  await expect(f.sealer.exportCompletedReviewContext(input, signal)).rejects.toThrow(
    /stream failed/,
  );
  const db = new Database(join(f.root, 'leases.db'));
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_pages').get()).toEqual({
    count: 0,
  });
  f.state.streamIncomplete = false;
  const result = await f.sealer.exportCompletedReviewContext(input, signal);
  expect(result.pages).toHaveLength(2);
  db.close();
});
it('releases a ready stream after page-zero return fails without a caller digest', async () => {
  const f = await fixture(['file'], true);
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  const db = new Database(join(f.root, 'leases.db'));
  db.exec(`CREATE TRIGGER fail_first_stream_page AFTER UPDATE OF ready ON symposium_review_streams
    WHEN NEW.ready=1 BEGIN
      DELETE FROM symposium_review_stream_pages
      WHERE fence_id=NEW.fence_id AND operation_id=NEW.operation_id AND page_index=0;
    END`);
  const input = {
    fenceId: seal.fenceId,
    operationId: 'stream-ready-return-failure',
    baseBranch: 'main',
    page: 0,
  };
  await expect(f.sealer.exportCompletedReviewContext(input, signal)).rejects.toThrow(
    /stream failed/,
  );
  expect(db.prepare('SELECT ready FROM symposium_review_streams').get()).toEqual({ ready: 1 });
  const release = {
    fenceId: seal.fenceId,
    operationId: input.operationId,
    baseBranch: input.baseBranch,
  };
  await expect(
    f.sealer.releaseReadyReviewStream({ ...release, baseBranch: 'other' }),
  ).rejects.toThrow(/journal changed/);
  expect(db.prepare('SELECT ready FROM symposium_review_streams').get()).toEqual({ ready: 1 });
  await f.sealer.releaseReadyReviewStream(release);
  await f.sealer.releaseReadyReviewStream(release);
  await expect(f.sealer.exportCompletedReviewContext(input, signal)).rejects.toThrow(
    /stream failed/,
  );
  expect(db.prepare('SELECT ready FROM symposium_review_streams').get()).toEqual({ ready: 1 });
  await f.sealer.releaseReadyReviewStream(release);
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_streams').get()).toEqual({
    count: 0,
  });
  expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_pages').get()).toEqual({
    count: 0,
  });
  expect(
    db.prepare('SELECT COUNT(*) AS count FROM symposium_review_stream_tombstones').get(),
  ).toEqual({ count: 1 });
  db.close();
});
it('never reconciles an active same-operation review helper', async () => {
  const f = await fixture(['file'], true);
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  let resume!: () => void;
  f.state.streamHold = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const input = {
    fenceId: seal.fenceId,
    operationId: 'stream-concurrent-1',
    baseBranch: 'main',
    page: 0,
  };
  const first = f.sealer.exportCompletedReviewContext(input, signal);
  for (
    let i = 0;
    i < 100 &&
    !f.command.mock.calls.some(
      (call) =>
        call[0][0] === 'create' &&
        call[0].some((arg) => arg.includes('mitzo.artifact-export-job=')),
    );
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 1));
  const removalsBefore = f.command.mock.calls.filter(
    (call) => call[0][0] === 'stop' || call[0][0] === 'rm',
  ).length;
  await expect(f.sealer.exportCompletedReviewContext(input, signal)).rejects.toThrow(
    /in progress|unauthorized physical mounts/,
  );
  expect(
    f.command.mock.calls.filter((call) => call[0][0] === 'stop' || call[0][0] === 'rm'),
  ).toHaveLength(removalsBefore);
  resume();
  await expect(first).resolves.toMatchObject({ receipt: { pageCount: 2 } });
});
it('rejects changed review context output and retains failed cleanup evidence', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  const original = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (...args) => {
    const output = await original(...args);
    if (args[0][0] !== 'start' || !output.includes('contextSha256')) return output;
    const value = JSON.parse(output);
    value.contextSha256 = '0'.repeat(64);
    return JSON.stringify(value);
  });
  await expect(
    f.sealer.exportCompletedReviewContext(
      { fenceId: seal.fenceId, operationId: 'review-context-bad', baseBranch: 'main' },
      signal,
    ),
  ).rejects.toThrow(/export failed/);
  const db = new Database(join(f.root, 'leases.db'));
  expect(db.prepare('SELECT state FROM symposium_seal_export_jobs').get()).toEqual({
    state: 'failed_cleaned',
  });
  db.close();
});
it('rejects a changed replay of the same review context operation', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  const input = { fenceId: seal.fenceId, operationId: 'review-context-repeat', baseBranch: 'main' };
  await f.sealer.exportCompletedReviewContext(input, signal);
  const original = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (...args) => {
    const output = await original(...args);
    if (args[0][0] !== 'start' || !output.includes('contextSha256')) return output;
    const value = JSON.parse(output);
    const context = JSON.parse(value.context);
    context.sourceBranch = 'other';
    value.context = canonicalReviewJson(context);
    value.contextSha256 = createHash('sha256').update(value.context).digest('hex');
    return JSON.stringify(value);
  });
  await expect(f.sealer.exportCompletedReviewContext(input, signal)).rejects.toThrow(
    /export failed/,
  );
  const db = new Database(join(f.root, 'leases.db'));
  expect(db.prepare('SELECT state FROM symposium_seal_export_jobs ORDER BY rowid').all()).toEqual([
    { state: 'complete' },
    { state: 'failed_cleaned' },
  ]);
  db.close();
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

it('does not expose malformed export bundle content through error causes', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const seal = await f.sealer.seal(f.input, f.runtime, signal);
  const original = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (args) => (args[0] === 'start' ? 'LEAK' : original(args)));
  try {
    await f.sealer.exportSuccessorArtifactBundle(
      {
        fenceId: seal.fenceId,
        operationId: 'malformed',
        sourceBranch: 'feature',
        baseBranch: 'main',
        sourceOid: seal.git.commit,
        maxBytes: 1024,
      },
      signal,
    );
    throw new Error('Expected malformed export rejection');
  } catch (error) {
    const messages: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause)
      messages.push(current.message);
    expect(messages.join('\n')).not.toContain('LEAK');
    expect(messages.join('\n')).toContain('retained helper state');
  }
});

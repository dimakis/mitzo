import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  SymposiumArtifactGenerations,
  type ArtifactGenerationRequest,
} from '../symposium-artifact-generations.js';
import {
  PhysicalArtifactSuccessorCopier,
  successorCopierContract,
} from '../symposium-artifact-successor-copy.js';
import { canonicalReviewJson, reviewRecordHash } from '../symposium-review-records.js';
import { artifactVolumeLabels } from '../symposium-session-artifacts.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from '../symposium-artifact-lease.js';
import { REVIEWED_SYMPOSIUM_OWNED_RUNTIME } from '../symposium-owned-runtime-contract.js';
import type { SuccessorArtifactExportReceipt } from '../symposium-physical-artifact-seal.js';
const digest = (v: unknown) => reviewRecordHash(canonicalReviewJson(v));
const hash = 'a'.repeat(64),
  oid = 'b'.repeat(40),
  helperId = 'c'.repeat(64);
const bundle = Buffer.from('unit fixture bytes');
const context = { sessionId: 'session', workspace: 'workspace', custodyDigest: hash };
const exportReceipt: SuccessorArtifactExportReceipt = {
  version: 1,
  mode: 'successor',
  jobId: 'job',
  operationId: 'copy',
  parentGenerationId: 'parent',
  parentVolumeName: 'parent-volume',
  parentSealDigest: hash,
  seal: {
    kind: 'completed_artifact_seal',
    version: 1,
    fenceId: 'fence',
    sessionId: 'session',
    custodyDigest: hash,
    intentDigest: hash,
    retentionDigest: hash,
    revocationDigest: hash,
    repositoryPath: '.',
    git: {
      version: 1,
      commit: oid,
      tree: oid,
      entries: 1,
      bytes: 10,
      manifestDigest: hash,
      committedTreeDigest: hash,
    },
    verifier: { id: helperId, image: 'unused', codeDigest: hash },
    completedAt: 1,
  },
  selection: {
    sourceRef: 'refs/heads/feature',
    sourceOid: oid,
    baseRef: 'refs/remotes/origin/main',
    baseOid: oid,
    defaultBranch: 'main',
    originUrl: 'https://github.com/example/repo',
  },
  bundleSha256: createHash('sha256').update(bundle).digest('hex'),
  bytes: bundle.length,
  helper: {
    id: helperId,
    name: 'export-helper',
    image: 'unused',
    codeDigest: hash,
    terminalExitCode: 0,
    removed: true,
  },
};
const dbs: Database.Database[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
function fixture(
  failure?: 'volume' | 'helper' | 'start' | 'remove' | 'revoked' | 'after-volume' | 'after-helper',
) {
  const db = new Database(':memory:');
  dbs.push(db);
  let allowed = true;
  const proof = {
    initial: () => true as const,
    authority: () => {
      if (!allowed) throw new Error('revoked');
      return true as const;
    },
    parent: () => true as const,
    copy: () => true as const,
  };
  const ledger = new SymposiumArtifactGenerations(db, proof);
  ledger.registerInitial({
    ...context,
    generationId: 'parent',
    volumeName: 'parent-volume',
    initializationReceiptDigest: hash,
  });
  const request: ArtifactGenerationRequest = {
    ...context,
    operationId: 'copy',
    expectedPointerRevision: 0,
    parentGenerationId: 'parent',
    parentSealDigest: hash,
    parentCommit: oid,
    parentTree: oid,
    parentManifestDigest: hash,
    parentCommittedTreeDigest: hash,
    bundleSha256: exportReceipt.bundleSha256,
    exportReceiptDigest: digest(exportReceipt),
    workflowId: 'workflow',
    fixAttemptId: 'fix',
    actor: 'owner',
    authorityGrantId: 'grant',
    authorityRevision: 1,
    seatId: 'writer',
    membershipGeneration: 1,
    accountId: 'account',
    model: 'luna-fixture',
    profileId: 'profile',
    profileRevision: '1',
    findingFingerprints: [hash],
    ...successorCopierContract(),
  };
  let volume: string | undefined,
    exists = false;
  let intent: ReturnType<typeof ledger.reserve> | undefined;
  const command = vi.fn(async (args: readonly string[], _max?: number, input?: Buffer) => {
    if (args[0] === 'volume' && args[1] === 'ls') return '[]';
    if (args[0] === 'volume' && args[1] === 'create') {
      if (failure === 'volume') throw new Error('uncertain');
      volume = args.at(-1)!;
      return volume;
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      if (failure === 'after-volume') allowed = false;
      return JSON.stringify([
        {
          Name: volume,
          Driver: 'local',
          Options: {},
          Labels: artifactVolumeLabels(context.workspace, {
            sessionId: context.sessionId,
            volumeName: volume!,
            volumeGeneration: intent!.generationId,
          }),
        },
      ]);
    }
    if (args[0] === 'create') {
      if (failure === 'helper') throw new Error('uncertain');
      exists = true;
      return helperId;
    }
    if (args[0] === 'inspect') {
      if (failure === 'after-helper') allowed = false;
      return JSON.stringify([
        {
          Id: helperId,
          ImageName: REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build.image,
          Config: {
            User: '998:998',
            Labels: { 'mitzo.artifact-generation': intent!.generationId },
          },
          HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false },
          Mounts: [
            { Type: 'volume', Name: volume, Destination: SYMPOSIUM_ARTIFACT_TARGET, RW: true },
          ],
          State: { Running: false, ExitCode: 0 },
        },
      ]);
    }
    if (args[0] === 'start') {
      expect(input).toEqual(bundle);
      if (failure === 'start') throw new Error('uncertain');
      if (failure === 'revoked') allowed = false;
      return JSON.stringify(exportReceipt.seal.git);
    }
    if (args[0] === 'rm') {
      if (failure === 'remove') throw new Error('uncertain');
      exists = false;
      return helperId;
    }
    if (args[0] === 'ps') return JSON.stringify(exists ? [{ Id: helperId }] : []);
    throw new Error('unexpected command');
  });
  const reserve = ledger.reserve.bind(ledger);
  vi.spyOn(ledger, 'reserve').mockImplementation((value) => (intent = reserve(value)));
  const sealer = {
    requireSuccessorExport: vi.fn(async () => exportReceipt.seal),
    assertRetainedSuccessorExport: vi.fn(() => true as const),
  };
  const copier = new PhysicalArtifactSuccessorCopier({
    ledger,
    sealer,
    command,
    custody: async () => {},
  });
  return { copier, ledger, request, command, sealer, intent: () => intent! };
}
it('physically verifies then activates only after exact helper removal and parent revalidation', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const result = await f.copier.copy(f.request, exportReceipt, bundle, signal);
  expect(f.ledger.active(context).generationId).toBe('parent');
  expect(f.ledger.historical(context, result.generationId).state).toBe('verified');
  expect(f.command.mock.calls.find(([args]) => args[0] === 'create')![0].join(' ')).not.toContain(
    'parent-volume',
  );
  await f.copier.activate(f.request, result.generationId, exportReceipt, bundle, signal);
  expect(f.ledger.active(context)).toEqual({ generationId: result.generationId, revision: 1 });
});
it('copies an imported source only through an exact retained initial export proof', async () => {
  const f = fixture();
  const initialExport = {
    ...exportReceipt,
    mode: 'initial' as const,
    sourceSealId: 'source-seal',
    seal: {
      sessionId: 'session',
      custodyDigest: hash,
      repositoryPath: '.' as const,
      git: exportReceipt.seal.git,
    },
  };
  const { fixAttemptId: _fix, findingFingerprints: _findings, ...common } = f.request;
  void _fix;
  void _findings;
  const initialRequest: ArtifactGenerationRequest = {
    ...common,
    kind: 'initial',
    sourceSealId: 'source-seal',
    initialAttemptId: 'attempt',
    policyReservationId: 'reservation',
    expectedConfigRevision: 1,
    predecessorMembershipGeneration: 1,
    accountBinding: {
      accountId: 'account',
      accountLabel: 'Account',
      provider: 'openai-codex',
      model: 'luna-fixture',
      profileRevision: '1',
    },
    contextGrant: { grantId: 'context', revision: 1 },
    exportReceiptDigest: digest(initialExport),
  };
  const initialSource = {
    assertRetainedInitialSourceExport: vi.fn(() => true as const),
    requireInitialSourceExport: vi.fn(async () => initialExport.seal),
  };
  const copier = new PhysicalArtifactSuccessorCopier({
    ledger: f.ledger,
    sealer: f.sealer,
    initialSource,
    command: f.command,
    custody: async () => {},
  });
  const result = await copier.copy(
    initialRequest,
    initialExport as never,
    bundle,
    new AbortController().signal,
  );
  expect(result.commit).toBe(oid);
  expect(initialSource.requireInitialSourceExport).toHaveBeenCalled();
  expect(f.sealer.requireSuccessorExport).not.toHaveBeenCalled();
});
it.each(['volume', 'helper', 'start', 'remove', 'revoked'] as const)(
  'retains %s uncertainty without redispatch or child activation',
  async (failure) => {
    const f = fixture(failure);
    const signal = new AbortController().signal;
    await expect(f.copier.copy(f.request, exportReceipt, bundle, signal)).rejects.toThrow();
    const intent = f.intent();
    expect(f.ledger.historical(context, intent.generationId).state).toBe('quarantined');
    expect(f.ledger.active(context).generationId).toBe('parent');
    const creates = f.command.mock.calls.filter(
      ([a]) => a[0] === 'create' || a[1] === 'create',
    ).length;
    await expect(f.copier.copy(f.request, exportReceipt, bundle, signal)).rejects.toThrow();
    expect(
      f.command.mock.calls.filter(([a]) => a[0] === 'create' || a[1] === 'create').length,
    ).toBe(creates);
    if (['start', 'remove', 'revoked'].includes(failure))
      expect(f.ledger.historical(context, intent.generationId).helperId).toBe(helperId);
  },
);

it.each(['after-volume', 'after-helper'] as const)(
  'does not dispatch new work after authority revocation %s',
  async (failure) => {
    const f = fixture(failure);
    await expect(
      f.copier.copy(f.request, exportReceipt, bundle, new AbortController().signal),
    ).rejects.toThrow();
    const commands = f.command.mock.calls.map(([args]) => args[0]);
    expect(commands).not.toContain('start');
    if (failure === 'after-volume') expect(commands).not.toContain('create');
  },
);
it('retains a freshly observable terminal exit after attached command rejection', async () => {
  const f = fixture('start');
  await expect(
    f.copier.copy(f.request, exportReceipt, bundle, new AbortController().signal),
  ).rejects.toThrow();
  expect(f.ledger.historical(context, f.intent().generationId).physical.at(-1)).toEqual({
    phase: 'terminal',
    helperId,
    exitCode: 0,
    proofDigest: null,
  });
});

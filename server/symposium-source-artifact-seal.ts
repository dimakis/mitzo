import { canonicalReviewJson } from './symposium-review-records.js';
import { createHash } from 'node:crypto';
import { ARTIFACT_GIT_EXPORT } from './symposium-artifact-git-export.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from './symposium-artifact-lease.js';
import { assertSourceVolume } from './symposium-source-physical-evidence.js';
import type { SymposiumArtifactOwner } from './symposium-artifact-owner.js';
import type { SymposiumSessionArtifacts } from './symposium-session-artifacts.js';

type Command = (args: readonly string[], maxOutputBytes?: number) => Promise<string>;
const containerId = /^[a-f0-9]{64}$/;
const verifierDigest = () => createHash('sha256').update(ARTIFACT_GIT_EXPORT).digest('hex');
export interface InitialSourceExportReceipt {
  version: 1;
  mode: 'initial';
  sourceSealId: string;
  operationId: string;
  parentGenerationId: string;
  parentVolumeName: string;
  parentSealDigest: string;
  seal: {
    sessionId: string;
    custodyDigest: string;
    repositoryPath: '.';
    git: {
      version: 1;
      commit: string;
      tree: string;
      entries: number;
      bytes: number;
      manifestDigest: string;
      committedTreeDigest: string;
    };
  };
  selection: {
    sourceRef: string;
    sourceOid: string;
    baseRef: string;
    baseOid: string;
    defaultBranch: string;
    originUrl: string;
  };
  bundleSha256: string;
  bytes: number;
  helper: {
    id: string;
    name: string;
    image: string;
    codeDigest: string;
    terminalExitCode: 0;
    removed: true;
  };
}

export function initialSourceExportReceipt(
  source: ReturnType<typeof requireCompletedImportedSourceSeal>,
  operationId: string,
): { receipt: InitialSourceExportReceipt; bundle: Buffer } {
  const seal = source.receipt;
  const exported = source.exported;
  return {
    receipt: {
      version: 1,
      mode: 'initial',
      sourceSealId: seal.operationId,
      operationId,
      parentGenerationId: seal.volumeGeneration,
      parentVolumeName: seal.volumeName,
      parentSealDigest: source.digest,
      seal: {
        sessionId: seal.sessionId,
        custodyDigest: createHash('sha256').update(seal.custody).digest('hex'),
        repositoryPath: '.',
        git: seal.git,
      },
      selection: exported.receipt.selection,
      bundleSha256: exported.receipt.bundleSha256,
      bytes: exported.receipt.bytes,
      helper: {
        id: seal.helperId,
        name: seal.helperName,
        image: seal.verifier.image,
        codeDigest: seal.verifier.codeDigest,
        terminalExitCode: 0,
        removed: true,
      },
    },
    bundle: exported.bundle,
  };
}

export function assertRetainedInitialSourceExport(
  artifacts: Pick<
    SymposiumSessionArtifacts,
    'sourceSealStatus' | 'sourceImportStatus' | 'getReady' | 'sourceSealExport'
  >,
  owner: SymposiumArtifactOwner,
  receipt: InitialSourceExportReceipt,
  bundle: Buffer,
): true {
  if (receipt.mode !== 'initial' || !Buffer.isBuffer(bundle))
    throw new Error('Retained initial source export unavailable');
  const retained = initialSourceExportReceipt(
    requireCompletedImportedSourceSeal(artifacts, owner, receipt.seal.sessionId),
    receipt.operationId,
  );
  if (
    canonicalReviewJson(retained.receipt) !== canonicalReviewJson(receipt) ||
    !retained.bundle.equals(bundle)
  )
    throw new Error('Retained initial source export changed');
  return true;
}

export async function requireInitialSourceExport(
  deps: {
    artifacts: Pick<
      SymposiumSessionArtifacts,
      'sourceSealStatus' | 'sourceImportStatus' | 'getReady' | 'sourceSealExport'
    >;
    owner: SymposiumArtifactOwner;
    workspace: string;
    custody(): void | Promise<void>;
    assertNoNativeClaims(sessionId: string): void | Promise<void>;
    command: Command;
  },
  receipt: InitialSourceExportReceipt,
  bundle: Buffer,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  assertRetainedInitialSourceExport(deps.artifacts, deps.owner, receipt, bundle);
  await deps.custody();
  await deps.assertNoNativeClaims(receipt.seal.sessionId);
  await assertSourceVolume({
    mapping: {
      sessionId: receipt.seal.sessionId,
      volumeName: receipt.parentVolumeName,
      volumeGeneration: receipt.parentGenerationId,
    },
    workspace: deps.workspace,
    owner: deps.owner,
    command: deps.command,
  });
  await deps.custody();
  signal.throwIfAborted();
  assertRetainedInitialSourceExport(deps.artifacts, deps.owner, receipt, bundle);
  return receipt.seal;
}

/** Synchronous retained parent proof for the generation ledger/EventStore callback.
 * The source fence prevents its original volume from being admitted for writes. */
export function requireCompletedImportedSourceSeal(
  artifacts: Pick<
    SymposiumSessionArtifacts,
    'sourceSealStatus' | 'sourceImportStatus' | 'getReady' | 'sourceSealExport'
  >,
  owner: SymposiumArtifactOwner,
  sessionId: string,
) {
  const seal = artifacts.sourceSealStatus(sessionId);
  const imported = artifacts.sourceImportStatus(sessionId);
  const mapping = artifacts.getReady(sessionId);
  if (
    !seal ||
    seal.state !== 'complete' ||
    !mapping ||
    imported.state !== 'imported' ||
    imported.admissionIssued ||
    seal.sessionId !== sessionId ||
    seal.volumeName !== mapping.volumeName ||
    seal.volumeGeneration !== mapping.volumeGeneration ||
    seal.verifier?.image !== owner.image ||
    seal.verifier?.codeDigest !== verifierDigest() ||
    seal.helperRemoved !== true ||
    seal.terminal?.helperId !== seal.helperId ||
    seal.terminal?.exitCode !== 0 ||
    canonicalReviewJson(seal.git) !== canonicalReviewJson(imported.receipt?.git) ||
    canonicalReviewJson(seal.sourceReceipt) !== canonicalReviewJson(imported.receipt)
  )
    throw new Error('Retained completed source seal unavailable');
  const exported = artifacts.sourceSealExport(sessionId);
  return {
    receipt: seal,
    digest: createHash('sha256').update(canonicalReviewJson(seal)).digest('hex'),
    exported,
  };
}

/** Permanent source fence precedes the helper. A retry may advance only after
 * rechecking the exact retained phase and a fresh physical helper census. */
export async function sealImportedSourceArtifact(
  deps: {
    artifacts: Pick<
      SymposiumSessionArtifacts,
      'beginSourceSeal' | 'sourceSealHelperReceipt' | 'completeSourceSeal'
    >;
    owner: SymposiumArtifactOwner;
    workspace: string;
    custody(): void | Promise<void>;
    assertNoNativeClaims(sessionId: string): void | Promise<void>;
    command: Command;
  },
  sessionId: string,
  operationId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await deps.custody();
  const pending = deps.artifacts.beginSourceSeal(sessionId, operationId);
  const imported = pending.sourceReceipt as {
    git: unknown;
    commit: string;
    manifest: { baseBranch: string; featureBranch: string; targetRepository: string };
  };
  const mapping = {
    sessionId,
    volumeName: pending.volumeName,
    volumeGeneration: pending.volumeGeneration,
  };
  const helperName = `${mapping.volumeName}-source-seal`;
  const helperCommand = [
    '-I',
    '-B',
    '-c',
    ARTIFACT_GIT_EXPORT,
    '.',
    JSON.stringify({
      kind: 'successor',
      expected: imported.git,
      baseBranch: imported.manifest.baseBranch,
      sourceBranch: imported.manifest.featureBranch,
      sourceOid: imported.commit,
      maxBytes: 8 * 1024 * 1024,
    }),
  ];
  const verify = async (helperId?: string) => {
    signal.throwIfAborted();
    await deps.custody();
    await deps.assertNoNativeClaims(sessionId);
    await assertSourceVolume({
      mapping,
      workspace: deps.workspace,
      owner: deps.owner,
      command: deps.command,
      helperId,
    });
    await deps.custody();
  };
  const inspectHelper = async (helperId: string) => {
    const raw: unknown = JSON.parse(await deps.command(['inspect', helperId]));
    if (!Array.isArray(raw) || raw.length !== 1) throw new Error('Source seal helper unavailable');
    const row = raw[0] as Record<string, unknown>;
    const config = row.Config as Record<string, unknown> | undefined;
    const host = row.HostConfig as Record<string, unknown> | undefined;
    const mounts = row.Mounts as Array<Record<string, unknown>> | undefined;
    if (
      row.Id !== helperId ||
      (typeof row.Name === 'string' ? row.Name.replace(/^\//, '') : '') !==
        `${mapping.volumeName}-source-seal` ||
      row.ImageName !== deps.owner.image ||
      config?.User !== `${deps.owner.uid}:${deps.owner.gid}` ||
      host?.NetworkMode !== 'none' ||
      host.ReadonlyRootfs !== true ||
      host.Privileged !== false ||
      !Array.isArray(mounts) ||
      mounts.length !== 1 ||
      mounts[0].Type !== 'volume' ||
      mounts[0].Name !== mapping.volumeName ||
      mounts[0].Destination !== SYMPOSIUM_ARTIFACT_TARGET ||
      mounts[0].RW !== false ||
      canonicalReviewJson(config?.Cmd) !== canonicalReviewJson(helperCommand) ||
      !(
        canonicalReviewJson(config?.Entrypoint) === canonicalReviewJson(['/usr/bin/python3']) ||
        config?.Entrypoint === '/usr/bin/python3'
      )
    )
      throw new Error('Source seal helper isolation changed');
    return row.State as { Running?: boolean; Status?: string; ExitCode?: number } | undefined;
  };
  const censusHelper = async (knownId?: string): Promise<string | null> => {
    const rows: unknown = JSON.parse(
      await deps.command(['ps', '--all', '--no-trunc', '--format', 'json']),
    );
    if (!Array.isArray(rows) || rows.length > 128)
      throw new Error('Source seal helper census unavailable');
    let found: string | null = null;
    for (const entry of rows) {
      const id = String(entry?.Id ?? entry?.ID ?? '');
      if (!containerId.test(id)) throw new Error('Source seal helper census unavailable');
      const inspected: unknown = JSON.parse(await deps.command(['inspect', id]));
      if (!Array.isArray(inspected) || inspected.length !== 1 || inspected[0]?.Id !== id)
        throw new Error('Source seal helper census changed');
      if (id === knownId && inspected[0].Name?.replace(/^\//, '') !== helperName)
        throw new Error('Source seal helper identity changed');
      if (inspected[0].Name?.replace(/^\//, '') === helperName) {
        if (found) throw new Error('Ambiguous source seal helper identity');
        found = id;
      }
    }
    return found;
  };
  const journal = deps.artifacts.sourceSealHelperReceipt(sessionId, operationId);
  if (pending.state === 'complete') {
    if (!pending.helperRemoved || (await censusHelper(pending.helperId)))
      throw new Error('Completed source seal helper changed');
    await verify();
    return pending;
  }
  if (pending.state !== 'pending') throw new Error('Source seal state changed');
  if (
    pending.verifier &&
    (pending.verifier.image !== deps.owner.image ||
      pending.verifier.codeDigest !== verifierDigest())
  )
    throw new Error('Source seal verifier identity changed');
  if (pending.helperName && pending.helperName !== helperName)
    throw new Error('Source seal helper intent changed');
  journal.verifier(deps.owner.image, verifierDigest());
  journal.intent(helperName);
  if (pending.helperId && !containerId.test(pending.helperId))
    throw new Error('Source seal helper identity changed');
  const observedId = await censusHelper(pending.helperId);
  if (pending.helperId && observedId && pending.helperId !== observedId)
    throw new Error('Source seal helper identity changed');
  if (pending.helperRemoved) {
    if (
      observedId ||
      pending.terminal?.helperId !== pending.helperId ||
      pending.terminal?.exitCode !== 0
    )
      throw new Error('Source seal cleanup changed');
    await verify();
    return deps.artifacts.completeSourceSeal(sessionId, operationId);
  }
  if (pending.helperId && !observedId) {
    if (
      pending.terminal?.helperId !== pending.helperId ||
      pending.terminal?.exitCode !== 0 ||
      !pending.git
    )
      throw new Error('Source seal helper disappearance is uncertain');
    await verify();
    journal.removed();
    return deps.artifacts.completeSourceSeal(sessionId, operationId);
  }
  let helperId = pending.helperId as string | undefined;
  if (observedId && !helperId) {
    await verify(observedId);
    await inspectHelper(observedId);
    journal.created(observedId);
    helperId = observedId;
  }
  if (!helperId) {
    await verify();
    signal.throwIfAborted();
    await deps.custody();
    helperId = (
      await deps.command([
        'create',
        '--pull=never',
        '--name',
        helperName,
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=32',
        '--memory=256m',
        '--cpus=1',
        '--timeout=50',
        '--user',
        `${deps.owner.uid}:${deps.owner.gid}`,
        '--mount',
        `type=volume,src=${mapping.volumeName},dst=${SYMPOSIUM_ARTIFACT_TARGET},readonly`,
        '--entrypoint=/usr/bin/python3',
        deps.owner.image,
        ...helperCommand,
      ])
    ).trim();
    if (!containerId.test(helperId)) throw new Error('Source seal helper identity unavailable');
    journal.created(helperId);
  }
  await verify(helperId);
  const created = await inspectHelper(helperId);
  let output: string;
  if (created?.Running === false && created.Status === 'created') {
    if (pending.git || pending.terminal) throw new Error('Source seal helper state regressed');
    signal.throwIfAborted();
    output = await deps.command(['start', '--attach', helperId], 16 * 1024 * 1024);
  } else if (created?.Running === false && created.Status === 'exited' && created.ExitCode === 0) {
    output = await deps.command(['logs', helperId], 16 * 1024 * 1024);
  } else {
    throw new Error('Source seal helper state uncertain');
  }
  if (Buffer.byteLength(output) > 16 * 1024 * 1024)
    throw new Error('Source seal export exceeded bound');
  const exported = JSON.parse(output) as Record<string, unknown>;
  const git: unknown = exported.proof;
  if (canonicalReviewJson(git) !== canonicalReviewJson(pending.sourceReceipt.git))
    throw new Error('Source seal Git proof differs from import');
  const selection = exported.selection as Record<string, unknown> | undefined;
  if (
    !selection ||
    selection.sourceRef !== `refs/heads/${imported.manifest.featureBranch}` ||
    selection.sourceOid !== imported.commit ||
    selection.baseRef !== `refs/remotes/origin/${imported.manifest.baseBranch}` ||
    selection.baseOid !== imported.commit ||
    selection.defaultBranch !== imported.manifest.baseBranch ||
    selection.originUrl !== `https://github.com/${imported.manifest.targetRepository}.git` ||
    typeof exported.bundle !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(exported.bundle)
  )
    throw new Error('Source seal export selection changed');
  const bundle = Buffer.from(exported.bundle, 'base64');
  if (
    !bundle.length ||
    bundle.length > 8 * 1024 * 1024 ||
    exported.bytes !== bundle.length ||
    exported.bundleSha256 !== createHash('sha256').update(bundle).digest('hex')
  )
    throw new Error('Source seal export integrity changed');
  journal.observed(git);
  journal.exported(
    { proof: git, selection, bundleSha256: exported.bundleSha256, bytes: bundle.length },
    bundle,
  );
  const terminal = await inspectHelper(helperId);
  if (terminal?.Running !== false || terminal.Status !== 'exited' || terminal.ExitCode !== 0)
    throw new Error('Source seal terminal success is unconfirmed');
  journal.terminal(helperId, 0);
  await verify(helperId);
  signal.throwIfAborted();
  await deps.command(['rm', helperId]);
  if (await censusHelper()) throw new Error('Source seal helper removal uncertain');
  journal.removed();
  await verify();
  return deps.artifacts.completeSourceSeal(sessionId, operationId);
}

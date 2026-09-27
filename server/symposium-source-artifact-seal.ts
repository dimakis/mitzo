import { canonicalReviewJson } from './symposium-review-records.js';
import { createHash } from 'node:crypto';
import { ARTIFACT_GIT_VERIFIER } from './symposium-artifact-git-verifier.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from './symposium-artifact-lease.js';
import { assertSourceVolume } from './symposium-source-physical-evidence.js';
import type { SymposiumArtifactOwner } from './symposium-artifact-owner.js';
import type { SymposiumSessionArtifacts } from './symposium-session-artifacts.js';

type Command = (args: readonly string[], maxOutputBytes?: number) => Promise<string>;
const containerId = /^[a-f0-9]{64}$/;
const verifierDigest = () => createHash('sha256').update(ARTIFACT_GIT_VERIFIER).digest('hex');

/** Synchronous retained parent proof for the generation ledger/EventStore callback.
 * The source fence prevents its original volume from being admitted for writes. */
export function requireCompletedImportedSourceSeal(
  artifacts: Pick<
    SymposiumSessionArtifacts,
    'sourceSealStatus' | 'sourceImportStatus' | 'getReady'
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
  return {
    receipt: seal,
    digest: createHash('sha256').update(canonicalReviewJson(seal)).digest('hex'),
  };
}

/** Permanent source fence precedes the helper. Any ambiguous create/start/cleanup
 * remains pending for explicit reconciliation; this function never retries it. */
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
  const mapping = {
    sessionId,
    volumeName: pending.volumeName,
    volumeGeneration: pending.volumeGeneration,
  };
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
      row.Name !== `/${mapping.volumeName}-source-seal` ||
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
      mounts[0].RW !== false
    )
      throw new Error('Source seal helper isolation changed');
    return row.State as { Running?: boolean; Status?: string; ExitCode?: number } | undefined;
  };
  await verify();
  const journal = deps.artifacts.sourceSealHelperReceipt(sessionId, operationId);
  journal.verifier(deps.owner.image, verifierDigest());
  const helperName = `${mapping.volumeName}-source-seal`;
  journal.intent(helperName);
  signal.throwIfAborted();
  await deps.custody();
  const helperId = (
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
      '-I',
      '-B',
      '-c',
      ARTIFACT_GIT_VERIFIER,
      '.',
    ])
  ).trim();
  if (!containerId.test(helperId)) throw new Error('Source seal helper identity unavailable');
  journal.created(helperId);
  await verify(helperId);
  const created = await inspectHelper(helperId);
  if (created?.Running !== false || created.Status !== 'created')
    throw new Error('Source seal helper state changed before start');
  signal.throwIfAborted();
  const output = await deps.command(['start', '--attach', helperId], 4096);
  if (Buffer.byteLength(output) > 4096) throw new Error('Source seal Git proof exceeded bound');
  const git: unknown = JSON.parse(output);
  if (canonicalReviewJson(git) !== canonicalReviewJson(pending.sourceReceipt.git))
    throw new Error('Source seal Git proof differs from import');
  journal.observed(git);
  const terminal = await inspectHelper(helperId);
  if (terminal?.Running !== false || terminal.Status !== 'exited' || terminal.ExitCode !== 0)
    throw new Error('Source seal terminal success is unconfirmed');
  journal.terminal(helperId, 0);
  await verify(helperId);
  signal.throwIfAborted();
  await deps.command(['rm', helperId]);
  journal.removed();
  await verify();
  return deps.artifacts.completeSourceSeal(sessionId, operationId);
}

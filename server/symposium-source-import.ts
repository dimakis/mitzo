import { inspectSourceHelper } from './symposium-source-physical-evidence.js';
import { createHash } from 'node:crypto';
import { SYMPOSIUM_ARTIFACT_TARGET } from './symposium-artifact-lease.js';
import type { SymposiumArtifactOwner } from './symposium-artifact-owner.js';
import type { ArtifactInitializerReceipt } from './symposium-artifact-initializer.js';
import {
  SOURCE_GIT_IMPORTER,
  SOURCE_BUNDLE_MAX_BYTES,
  type SourceManifest,
} from './symposium-source-git.js';
export const SOURCE_IMPORT_CONTRACT = createHash('sha256')
  .update(SOURCE_GIT_IMPORTER)
  .digest('hex');
export type SourceImportProof = {
  commit: string;
  tree: string;
  featureBranch: string;
  bundleSha256: string;
  files: number;
  bytes: number;
  git: {
    version: 1;
    commit: string;
    tree: string;
    entries: number;
    bytes: number;
    manifestDigest: string;
    committedTreeDigest: string;
  };
  terminal?: { helperId: string; exitCode: 0 };
};
export class SourceImportAttemptError extends Error {
  constructor(
    readonly outcome: 'failed' | 'uncertain',
    readonly exitCode?: number,
  ) {
    super('Source helper import did not produce a verified completion');
  }
}
export async function importSourceArtifact(input: {
  name: string;
  owner: SymposiumArtifactOwner;
  bundle: Buffer;
  manifest: SourceManifest;
  command(args: readonly string[], input?: Buffer): Promise<string>;
  verifyVolume(helperId?: string): Promise<void>;
  custody(): void;
  authorize(): void;
  receipt: ArtifactInitializerReceipt;
  observed(proof: SourceImportProof): void;
}): Promise<SourceImportProof> {
  const { name, owner, bundle, manifest, command, custody, authorize, receipt } = input;
  if (
    !/^mitzo-artifacts-[A-Za-z0-9-]+$/.test(name) ||
    !bundle.length ||
    bundle.length > SOURCE_BUNDLE_MAX_BYTES ||
    bundle.length !== manifest.bundleBytes ||
    createHash('sha256').update(bundle).digest('hex') !== manifest.bundleSha256
  )
    throw Error('Invalid source artifact input');
  custody();
  authorize();
  await input.verifyVolume();
  custody();
  authorize();
  const helperName = `${name}-import`;
  // Never remove or retry a helper after ambiguous create/start.
  receipt.intent(helperName);
  const helperId = (
    await command([
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
      '--interactive',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=16m,mode=1777',
      '--user',
      `${owner.uid}:${owner.gid}`,
      '--mount',
      `type=volume,src=${name},dst=${SYMPOSIUM_ARTIFACT_TARGET}`,
      '--entrypoint=/usr/bin/python3',
      owner.image,
      '-I',
      '-B',
      '-c',
      SOURCE_GIT_IMPORTER,
      SYMPOSIUM_ARTIFACT_TARGET,
      '-',
      JSON.stringify(manifest),
    ])
  ).trim();
  if (!/^[a-f0-9]{64}$/.test(helperId)) throw Error('Source helper identity unavailable');
  receipt.created(helperId);
  custody();
  authorize();
  await input.verifyVolume(helperId);
  const created = await inspectSourceHelper({ command, helperId, name, owner });
  if (created.State?.Running !== false || created.State.Status !== 'created')
    throw Error('Source helper state changed before start');
  custody();
  authorize();
  let output: string;
  try {
    output = await command(['start', '--attach', '--interactive', helperId], bundle);
  } catch {
    let exitCode: number | undefined;
    try {
      const row = await inspectSourceHelper({ command, helperId, name, owner });
      if (
        row.State?.Running === false &&
        row.State.Status === 'exited' &&
        Number.isInteger(row.State.ExitCode) &&
        row.State.ExitCode! > 0 &&
        row.State.ExitCode! <= 255
      )
        exitCode = row.State.ExitCode;
    } catch {
      /* No conclusive physical observation: retain uncertainty. */
    }
    throw new SourceImportAttemptError(exitCode === undefined ? 'uncertain' : 'failed', exitCode);
  }
  const proof = JSON.parse(output) as SourceImportProof;
  if (
    proof.commit !== manifest.baseOid ||
    proof.tree !== manifest.treeOid ||
    proof.featureBranch !== manifest.featureBranch ||
    proof.bundleSha256 !== manifest.bundleSha256 ||
    proof.git?.version !== 1 ||
    proof.git.commit !== manifest.baseOid ||
    proof.git.tree !== manifest.treeOid ||
    proof.git.entries !== proof.files ||
    proof.git.bytes !== proof.bytes ||
    !/^[a-f0-9]{64}$/.test(proof.git.manifestDigest) ||
    !/^[a-f0-9]{64}$/.test(proof.git.committedTreeDigest) ||
    !Number.isInteger(proof.files) ||
    proof.files < 0 ||
    proof.files > 10000 ||
    !Number.isInteger(proof.bytes) ||
    proof.bytes < 0 ||
    proof.bytes > 64 * 1024 * 1024
  )
    throw Error('Source import proof changed');
  input.observed(proof); // Persist terminal output before post-operation custody can fail.
  const terminal = await inspectSourceHelper({ command, helperId, name, owner });
  if (
    terminal.State?.Running !== false ||
    terminal.State.Status !== 'exited' ||
    terminal.State.ExitCode !== 0
  )
    throw new SourceImportAttemptError('uncertain');
  proof.terminal = { helperId, exitCode: 0 };
  input.observed(proof);
  custody();
  await command(['rm', helperId]);
  receipt.removed();
  return proof;
}

import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { workspacePreservationProgram } from './workspace-preservation-helper.js';

const identity = z.strictObject({
  dev: z.number().int().nonnegative().safe(),
  ino: z.number().int().nonnegative().safe(),
});
const canonical = z.string().refine((path) => isAbsolute(path) && resolve(path) === path);
export const WorkspaceArchiveSchema = z.strictObject({
  version: z.literal(1),
  directory: canonical,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.number().int().nonnegative().max(100000),
  bytes: z.number().int().nonnegative().max(2147483648),
});
export type WorkspaceArchive = z.infer<typeof WorkspaceArchiveSchema>;
export const WorkspaceRetirementReceiptSchema = z
  .strictObject({
    version: z.literal(1),
    operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    workspaceId: z.string().min(1).max(200),
    directory: canonical,
    rootIdentity: identity,
    state: z.enum(['archiving', 'verified', 'retired']),
    archive: WorkspaceArchiveSchema.optional(),
  })
  .refine(
    (value) => value.state === 'archiving' || !!value.archive,
    'Verified preservation required',
  );
export type WorkspaceRetirementReceipt = z.infer<typeof WorkspaceRetirementReceiptSchema>;
/** Fresh exclusive authority from the existing allocation owner. Its current
 * fence must bind operator/account, exact durable record, no active/queued work,
 * no resume/history references and its retirement lease on every await. Archive
 * data and historical preparation approvals are never this authority. */
export interface WorkspaceRetirementOwner {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly directory: string;
  readonly rootIdentity: Readonly<{ dev: number; ino: number }>;
  readonly archiveRoot: string;
  readonly previousReceipt?: WorkspaceRetirementReceipt;
  assertCurrent(): Promise<void>;
  record(receipt: WorkspaceRetirementReceipt): Promise<void>;
  /** Existing current effect boundary owns removal; no generic force fallback. */
  remove(
    expected: Readonly<{ dev: number; ino: number }>,
    archive: WorkspaceArchive,
  ): Promise<void>;
}
const proofSchema = WorkspaceArchiveSchema.omit({ version: true, directory: true });
function helper(input: object): Promise<z.infer<typeof proofSchema>> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      '/usr/bin/python3',
      ['-I', '-c', workspacePreservationProgram],
      {
        timeout: 60000,
        maxBuffer: 16384,
        env: { PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
      },
      (error, stdout, stderr) => {
        if (error)
          return reject(Error(stderr.trim().split('\n').at(-1) || 'Workspace preservation failed'));
        try {
          resolve(proofSchema.parse(JSON.parse(stdout)));
        } catch (cause) {
          reject(cause);
        }
      },
    );
    child.stdin?.end(JSON.stringify(input));
  });
}
const inside = (path: string, root: string) => {
  const suffix = relative(root, path);
  return (
    suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
  );
};
async function privateRoot(path: string) {
  canonical.parse(path);
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw Error('Private canonical archive root required');
}
async function sourceIdentity(path: string, expected: WorkspaceRetirementOwner['rootIdentity']) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    info.dev !== expected.dev ||
    info.ino !== expected.ino
  )
    throw Error('Workspace identity changed');
}
/** Open editor handles may still write into the retained original tree. Keep
 * those bytes and refuse automatic restoration of an older archive snapshot. */
async function assertRetainedSourceUnchanged(archive: WorkspaceArchive): Promise<void> {
  const retained = join(archive.directory, 'retained-source');
  const exists = await lstat(retained).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!exists) return; // Historical archives predate retained-source retirement.
  const current = await helper({ mode: 'verify', source: retained });
  if (
    current.sha256 !== archive.sha256 ||
    current.files !== archive.files ||
    current.bytes !== archive.bytes
  )
    throw Error(
      'Retained source changed after preservation; reconcile its preserved newer work before restoring',
    );
}
/** Restore to a fresh destination and verify every file, link and mode against
 * the retained digest. Never executes Git/config/hooks or overwrites a checkout. */
export async function restoreWorkspaceArchive(
  archive: WorkspaceArchive,
  destination: string,
): Promise<void> {
  const value = WorkspaceArchiveSchema.parse(archive);
  canonical.parse(destination);
  const { sha256, files, bytes } = value;
  await privateRoot(value.directory);
  await assertRetainedSourceUnchanged(value);
  await helper({
    mode: 'restore',
    source: join(value.directory, 'checkout'),
    destination,
    proof: { sha256, files, bytes },
  });
  await assertRetainedSourceUnchanged(value);
}
/** Read-only reconciliation for a restore interrupted before its final journal
 * write. Only exact archive equality can qualify the existing restored bytes. */
export async function verifyWorkspaceArchiveRestoration(
  archive: WorkspaceArchive,
  directory: string,
): Promise<void> {
  const value = WorkspaceArchiveSchema.parse(archive);
  await assertRetainedSourceUnchanged(value);
  const actual = await helper({ mode: 'verify', source: canonical.parse(directory) });
  if (
    actual.sha256 !== value.sha256 ||
    actual.files !== value.files ||
    actual.bytes !== value.bytes
  )
    throw Error('Restored workspace differs from retained archive');
}
/** Retire the original inode tree into its owned archive on the same filesystem.
 * Never unlink user data: post-proof writes through editor handles remain in
 * retained-source and must be reconciled before restoring. */
export async function removePreservedWorkspace(
  directory: string,
  expected: WorkspaceRetirementOwner['rootIdentity'],
  archive: WorkspaceArchive,
): Promise<void> {
  const value = WorkspaceArchiveSchema.parse(archive);
  await privateRoot(value.directory);
  const proof = { sha256: value.sha256, files: value.files, bytes: value.bytes };
  const archived = await helper({ mode: 'verify', source: join(value.directory, 'checkout') });
  if (JSON.stringify(archived) !== JSON.stringify(proof))
    throw Error('Retained archive verification failed');
  await helper({
    mode: 'remove',
    source: canonical.parse(directory),
    identity: identity.parse(expected),
    retainedSource: join(value.directory, 'retained-source'),
    proof,
  });
}
export async function retireOwnedWorkspace(
  owner: WorkspaceRetirementOwner,
): Promise<WorkspaceRetirementReceipt> {
  if (!Object.isFrozen(owner)) throw Error('Original workspace retirement owner required');
  const { assertCurrent, record, remove } = owner;
  const base = WorkspaceRetirementReceiptSchema.parse({
    version: 1,
    operationId: owner.operationId,
    workspaceId: owner.workspaceId,
    directory: owner.directory,
    rootIdentity: owner.rootIdentity,
    state: 'archiving',
  });
  const archiveRoot = canonical.parse(owner.archiveRoot);
  const archiveDirectory = join(archiveRoot, base.operationId);
  if (inside(archiveRoot, base.directory) || inside(base.directory, archiveRoot))
    throw Error('Archive and workspace must have separate ownership roots');
  const current = async () => {
    if (
      owner.assertCurrent !== assertCurrent ||
      owner.record !== record ||
      owner.remove !== remove ||
      owner.operationId !== base.operationId ||
      owner.workspaceId !== base.workspaceId ||
      owner.directory !== base.directory ||
      owner.rootIdentity.dev !== base.rootIdentity.dev ||
      owner.rootIdentity.ino !== base.rootIdentity.ino ||
      owner.archiveRoot !== archiveRoot
    )
      throw Error('Original workspace retirement owner changed');
    await assertCurrent.call(owner);
  };
  const retain = async (receipt: WorkspaceRetirementReceipt) => {
    await current();
    await record.call(owner, structuredClone(receipt));
    await current();
  };
  await current();
  await privateRoot(archiveRoot);
  await current();
  let archive: WorkspaceArchive;
  if (owner.previousReceipt?.state === 'verified' || owner.previousReceipt?.state === 'retired') {
    const previous = WorkspaceRetirementReceiptSchema.parse(owner.previousReceipt);
    if (
      previous.operationId !== base.operationId ||
      previous.workspaceId !== base.workspaceId ||
      previous.directory !== base.directory ||
      previous.rootIdentity.dev !== base.rootIdentity.dev ||
      previous.rootIdentity.ino !== base.rootIdentity.ino ||
      previous.archive?.directory !== archiveDirectory
    )
      throw Error('Original retirement receipt required');
    archive = previous.archive;
    const proof = await helper({ mode: 'verify', source: join(archive.directory, 'checkout') });
    if (
      JSON.stringify(proof) !==
      JSON.stringify({ sha256: archive.sha256, files: archive.files, bytes: archive.bytes })
    )
      throw Error('Retained archive verification failed');
    await current();
    try {
      await sourceIdentity(base.directory, base.rootIdentity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const retired = { ...base, state: 'retired' as const, archive };
      await retain(retired);
      return retired;
    }
  } else {
    await sourceIdentity(base.directory, base.rootIdentity);
    await current();
    await retain(base);
    await mkdir(archiveDirectory, { mode: 0o700 });
    await current();
    const proof = await helper({
      mode: 'archive',
      source: base.directory,
      destination: join(archiveDirectory, 'checkout'),
      identity: base.rootIdentity,
    });
    await current();
    archive = WorkspaceArchiveSchema.parse({ version: 1, directory: archiveDirectory, ...proof });
    const restore = join(archiveDirectory, 'restore-verification');
    await restoreWorkspaceArchive(archive, restore);
    await current();
    // Only this freshly created verification copy is disposable scratch. The
    // durable archive/source survive every failure and all uncertain operations.
    await rm(restore, { recursive: true });
    await current();
    await retain({ ...base, state: 'verified', archive });
  }
  const actual = await helper({
    mode: 'verify',
    source: base.directory,
    identity: base.rootIdentity,
  });
  if (
    actual.sha256 !== archive.sha256 ||
    actual.files !== archive.files ||
    actual.bytes !== archive.bytes
  )
    throw Error('Workspace changed after preservation');
  await current();
  await sourceIdentity(base.directory, base.rootIdentity);
  await current();
  await remove.call(owner, base.rootIdentity, archive);
  await current();
  const retired = { ...base, state: 'retired' as const, archive };
  await retain(retired);
  return retired;
}

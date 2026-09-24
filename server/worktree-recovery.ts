import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join, resolve, sep } from 'path';
import type { WorktreeFileEvidence, WorktreeManifestEntry } from './worktree-manifest.js';

interface RecoveryFileRecord {
  path: string;
  sha256: string;
  mode: number;
  kinds: WorktreeFileEvidence['kinds'];
}

interface RecoveryArtifactRecord {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface WorktreeRecoveryMetadata {
  schemaVersion: 1;
  createdAt: string;
  source: {
    repository: string;
    worktree: string;
    sessionId: string;
    branch: string | null;
    head: string;
  };
  trackedFiles: RecoveryFileRecord[];
  selectedUntrackedFiles: RecoveryFileRecord[];
  artifacts: RecoveryArtifactRecord[];
}

export interface CreateWorktreeRecoveryPackageOptions {
  entry: WorktreeManifestEntry;
  destinationRoot: string;
  selectedUntrackedPaths: string[];
  packageName?: string;
  createdAt?: Date;
}

export interface WorktreeRecoveryPackageResult {
  path: string;
  metadata: WorktreeRecoveryMetadata;
}

export interface RehearseWorktreeRecoveryOptions {
  packagePath: string;
  destination: string;
}

export interface WorktreeRecoveryRehearsalResult {
  verified: true;
  destination: string;
  head: string;
  status: string;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function git(repository: string, args: string[], encoding?: BufferEncoding): string | Buffer {
  return execFileSync('git', ['-C', repository, ...args], {
    ...(encoding ? { encoding } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

function canonicalExisting(path: string): string {
  return realpathSync(resolve(path));
}

function isInside(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

function safeRelativePath(path: string): string {
  if (!path || path.includes('\0')) throw new Error('recovery path is invalid');
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`recovery path escapes the worktree: ${path}`);
  }
  return normalized;
}

function fileRecord(sourceRoot: string, evidence: WorktreeFileEvidence): RecoveryFileRecord {
  const path = safeRelativePath(evidence.path);
  const source = resolve(sourceRoot, path);
  if (!isInside(sourceRoot, source) || evidence.hashStatus !== 'hashed' || !evidence.sha256) {
    throw new Error(`${path} is not eligible for recovery packaging`);
  }
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || sha256(source) !== evidence.sha256) {
    throw new Error(`${path} changed after manifest capture`);
  }
  return { path, sha256: evidence.sha256, mode: stat.mode & 0o777, kinds: evidence.kinds };
}

function writePrivate(path: string, contents: string | Buffer): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function artifactRecord(packagePath: string, path: string): RecoveryArtifactRecord {
  const absolute = join(packagePath, path);
  return { path, sha256: sha256(absolute), sizeBytes: statSync(absolute).size };
}

function readMetadata(packagePath: string): WorktreeRecoveryMetadata {
  const metadata = JSON.parse(
    readFileSync(join(packagePath, 'metadata.json'), 'utf8'),
  ) as WorktreeRecoveryMetadata;
  if (metadata.schemaVersion !== 1 || !metadata.source?.head) {
    throw new Error('unsupported or invalid worktree recovery metadata');
  }
  for (const artifact of metadata.artifacts) {
    const path = join(packagePath, safeRelativePath(artifact.path));
    if (
      !existsSync(path) ||
      statSync(path).size !== artifact.sizeBytes ||
      sha256(path) !== artifact.sha256
    ) {
      throw new Error(`recovery artifact verification failed: ${artifact.path}`);
    }
  }
  return metadata;
}

function nulPaths(output: string | Buffer): string[] {
  return output.toString().split('\0').filter(Boolean).sort();
}

function equalPaths(actual: string[], expected: string[], label: string): void {
  const normalizedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(normalizedExpected)) {
    throw new Error(`${label} did not match recovery metadata`);
  }
}

export function createWorktreeRecoveryPackage(
  options: CreateWorktreeRecoveryPackageOptions,
): WorktreeRecoveryPackageResult {
  const { entry } = options;
  if (!entry.registered || !entry.head) throw new Error('registered worktree HEAD is required');
  const repository = canonicalExisting(entry.repository);
  const worktree = canonicalExisting(entry.path);
  const destinationRoot = canonicalExisting(options.destinationRoot);
  if (isInside(repository, destinationRoot)) {
    throw new Error('recovery packages must be stored outside the source repository');
  }

  const selected = [...new Set(options.selectedUntrackedPaths)].map(safeRelativePath);
  const selectedEvidence = selected.map((path) => {
    const evidence = entry.files.find(
      (file) => file.path === path && file.kinds.includes('untracked'),
    );
    if (!evidence) throw new Error(`${path} is not eligible for recovery packaging`);
    return fileRecord(worktree, evidence);
  });
  const trackedEvidence = entry.files.filter(
    (file) => file.kinds.includes('staged') || file.kinds.includes('modified'),
  );
  const unsupportedTracked = trackedEvidence.find(
    (file) => file.hashStatus !== 'hashed' || !file.sha256,
  );
  if (unsupportedTracked) {
    throw new Error(
      `tracked path is not eligible for verified recovery packaging: ${unsupportedTracked.path}`,
    );
  }
  const trackedFiles = trackedEvidence.map((file) => fileRecord(worktree, file));

  const createdAt = options.createdAt ?? new Date();
  const packageName =
    options.packageName ?? `${entry.sessionId}-${createdAt.toISOString().replaceAll(':', '')}`;
  const finalPath = join(destinationRoot, safeRelativePath(packageName));
  if (existsSync(finalPath)) throw new Error(`recovery package already exists: ${finalPath}`);
  const temporaryPath = join(destinationRoot, `.${basename(finalPath)}.${process.pid}.partial`);
  if (existsSync(temporaryPath))
    throw new Error(`partial recovery package already exists: ${temporaryPath}`);
  mkdirSync(temporaryPath, { mode: 0o700 });
  chmodSync(temporaryPath, 0o700);

  const stagedPatch = git(worktree, ['diff', '--cached', '--binary', '--no-ext-diff']);
  const unstagedPatch = git(worktree, ['diff', '--binary', '--no-ext-diff']);
  writePrivate(join(temporaryPath, 'staged.patch'), stagedPatch);
  writePrivate(join(temporaryPath, 'unstaged.patch'), unstagedPatch);
  const bundle = join(temporaryPath, 'history.bundle');
  git(worktree, ['bundle', 'create', bundle, 'HEAD']);
  chmodSync(bundle, 0o600);

  for (const file of selectedEvidence) {
    const destination = join(temporaryPath, 'untracked', file.path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    chmodSync(dirname(destination), 0o700);
    copyFileSync(join(worktree, file.path), destination);
    chmodSync(destination, file.mode & 0o111 ? 0o700 : 0o600);
  }

  const artifactPaths = [
    'history.bundle',
    'staged.patch',
    'unstaged.patch',
    ...selectedEvidence.map((file) => join('untracked', file.path)),
  ];
  const metadata: WorktreeRecoveryMetadata = {
    schemaVersion: 1,
    createdAt: createdAt.toISOString(),
    source: {
      repository,
      worktree,
      sessionId: entry.sessionId,
      branch: entry.branch,
      head: entry.head,
    },
    trackedFiles,
    selectedUntrackedFiles: selectedEvidence,
    artifacts: artifactPaths.map((path) => artifactRecord(temporaryPath, path)),
  };
  writePrivate(join(temporaryPath, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  renameSync(temporaryPath, finalPath);
  return { path: finalPath, metadata };
}

export function rehearseWorktreeRecovery(
  options: RehearseWorktreeRecoveryOptions,
): WorktreeRecoveryRehearsalResult {
  const packagePath = canonicalExisting(options.packagePath);
  const destination = resolve(options.destination);
  if (existsSync(destination))
    throw new Error(`rehearsal destination already exists: ${destination}`);
  if (isInside(packagePath, destination)) {
    throw new Error('rehearsal destination must be outside the recovery package');
  }
  const metadata = readMetadata(packagePath);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  chmodSync(dirname(destination), 0o700);
  execFileSync('git', ['init', destination], { stdio: 'pipe' });
  git(destination, ['fetch', join(packagePath, 'history.bundle'), 'HEAD']);
  git(destination, ['checkout', '--detach', 'FETCH_HEAD']);

  const stagedPatch = join(packagePath, 'staged.patch');
  const unstagedPatch = join(packagePath, 'unstaged.patch');
  if (statSync(stagedPatch).size > 0) git(destination, ['apply', '--index', stagedPatch]);
  if (statSync(unstagedPatch).size > 0) git(destination, ['apply', unstagedPatch]);
  for (const file of metadata.selectedUntrackedFiles) {
    const target = join(destination, safeRelativePath(file.path));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(join(packagePath, 'untracked', file.path), target);
    chmodSync(target, file.mode);
  }

  const head = git(destination, ['rev-parse', 'HEAD'], 'utf8').toString().trim();
  if (head !== metadata.source.head)
    throw new Error('restored HEAD does not match recovery metadata');
  equalPaths(
    nulPaths(git(destination, ['diff', '--cached', '--name-only', '-z'])),
    metadata.trackedFiles.filter((file) => file.kinds.includes('staged')).map((file) => file.path),
    'staged paths',
  );
  equalPaths(
    nulPaths(git(destination, ['diff', '--name-only', '-z'])),
    metadata.trackedFiles
      .filter((file) => file.kinds.includes('modified'))
      .map((file) => file.path),
    'modified paths',
  );
  equalPaths(
    nulPaths(git(destination, ['ls-files', '--others', '--exclude-standard', '-z'])),
    metadata.selectedUntrackedFiles.map((file) => file.path),
    'untracked paths',
  );
  for (const file of [...metadata.trackedFiles, ...metadata.selectedUntrackedFiles]) {
    if (sha256(join(destination, file.path)) !== file.sha256) {
      throw new Error(`restored file checksum mismatch: ${file.path}`);
    }
  }

  const status = git(destination, ['status', '--porcelain=v1'], 'utf8').toString();
  return { verified: true, destination, head, status };
}

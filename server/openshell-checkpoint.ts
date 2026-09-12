import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PROVIDER_FILES = new Set([
  '.sandbox_migration',
  'goals_1.sqlite',
  'goals_1.sqlite-shm',
  'goals_1.sqlite-wal',
  'installation_id',
  'memories_1.sqlite',
  'memories_1.sqlite-shm',
  'memories_1.sqlite-wal',
  'queue_1.sqlite',
  'queue_1.sqlite-shm',
  'queue_1.sqlite-wal',
  'state_5.sqlite',
  'state_5.sqlite-shm',
  'state_5.sqlite-wal',
  'thread_history_1.sqlite',
  'thread_history_1.sqlite-shm',
  'thread_history_1.sqlite-wal',
]);
const PROVIDER_DIRECTORIES = new Set(['sessions', 'archived_sessions', 'skills']);
const VOLATILE = new Set([
  'tmp',
  '.tmp',
  'thread-writer-locks',
  'logs_2.sqlite',
  'logs_2.sqlite-shm',
  'logs_2.sqlite-wal',
  'shell_snapshots',
]);
const CREDENTIAL =
  /(^|\/)(\.env(?:\..*)?|auth\.json|credentials?(?:\.json)?|\.aws|\.ssh|\.config\/(?:gcloud|gh)|\.codex)(?:$|\/)/i;
const MAX_FILES = 100_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface OpenShellCheckpointManifest {
  version: 1;
  conversationId: string;
  threadId: string;
  sandboxId: string;
  bindingKey: string;
  digest: string;
}
interface CaptureOptions {
  source: string;
  destination: string;
  conversationId: string;
  threadId: string;
  sandboxId: string;
  bindingKey: string;
}
interface RestoreOptions {
  checkpoint: string;
  destination: string;
  conversationId: string;
  threadId: string;
  bindingKey: string;
}
function ensureChild(root: string, path: string) {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel.startsWith('..') || rel.includes('/../'))
    throw new Error('checkpoint path escapes root');
}
function walk(root: string, path = root): string[] {
  if (lstatSync(path).isSymbolicLink()) throw new Error('checkpoint does not support symlinks');
  const entries: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    ensureChild(root, full);
    if (entry.isSymbolicLink()) throw new Error('checkpoint does not support symlinks');
    if (entry.isDirectory()) entries.push(...walk(root, full));
    else if (entry.isFile()) entries.push(full);
    else throw new Error('checkpoint does not support special files');
  }
  return entries;
}
function hashTree(root: string, excludeRootManifest = false) {
  const hash = createHash('sha256');
  const files = walk(root).filter(
    (file) => !(excludeRootManifest && file === join(root, 'manifest.json')),
  );
  if (files.length > MAX_FILES) throw new Error('checkpoint has too many files');
  let bytes = 0;
  for (const file of files.sort()) {
    const rel = relative(root, file);
    const stat = statSync(file);
    bytes += stat.size;
    if (bytes > MAX_BYTES) throw new Error('checkpoint exceeds size limit');
    hash.update(rel);
    hash.update('\0');
    hash.update(String(stat.mode & 0o777));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}
function verifyProvider(source: string) {
  if (!existsSync(source)) throw new Error('provider state is missing');
  if (lstatSync(source).isSymbolicLink()) throw new Error('unsupported provider symlink');
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (VOLATILE.has(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error('unsupported provider symlink');
    if (entry.isDirectory() && PROVIDER_DIRECTORIES.has(entry.name)) {
      walk(source, join(source, entry.name));
      continue;
    }
    if (entry.isFile() && PROVIDER_FILES.has(entry.name)) continue;
    throw new Error(`unsupported provider state: ${entry.name}`);
  }
}
function verifyWorkspace(source: string) {
  if (!existsSync(source)) throw new Error('workspace is missing');
  for (const file of walk(source)) {
    if (CREDENTIAL.test(relative(source, file)))
      throw new Error('credential-like workspace file blocks checkpoint');
  }
}
function copy(source: string, destination: string) {
  cpSync(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
}
function copyProvider(source: string, destination: string) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (PROVIDER_FILES.has(entry.name) || PROVIDER_DIRECTORIES.has(entry.name))
      copy(join(source, entry.name), join(destination, entry.name));
  }
}

/** Strict portable checkpoint format. The caller must quiesce all sandbox writers first. */
export function captureOpenShellCheckpoint(options: CaptureOptions): OpenShellCheckpointManifest {
  const source = resolve(options.source);
  const provider = join(source, '.codex');
  const workspace = join(source, 'workspace');
  verifyProvider(provider);
  verifyWorkspace(workspace);
  if (existsSync(options.destination)) throw new Error('checkpoint destination already exists');
  const stage = `${options.destination}.staging`;
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    copyProvider(provider, join(stage, '.codex'));
    copy(workspace, join(stage, 'workspace'));
    const manifest: OpenShellCheckpointManifest = {
      version: 1,
      conversationId: options.conversationId,
      threadId: options.threadId,
      sandboxId: options.sandboxId,
      bindingKey: options.bindingKey,
      digest: hashTree(stage),
    };
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    renameSync(stage, options.destination);
    return manifest;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

export function restoreOpenShellCheckpoint(options: RestoreOptions) {
  const manifestPath = join(options.checkpoint, 'manifest.json');
  let manifest: OpenShellCheckpointManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as OpenShellCheckpointManifest;
  } catch {
    throw new Error('checkpoint manifest is corrupt');
  }
  if (
    manifest.version !== 1 ||
    manifest.conversationId !== options.conversationId ||
    manifest.threadId !== options.threadId ||
    manifest.bindingKey !== options.bindingKey
  )
    throw new Error('checkpoint identity does not match conversation');
  if (hashTree(options.checkpoint, true) !== manifest.digest)
    throw new Error('checkpoint content digest is invalid');
  if (existsSync(options.destination)) throw new Error('restore destination already exists');
  const stage = `${options.destination}.staging`;
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    copy(join(options.checkpoint, '.codex'), join(stage, '.codex'));
    copy(join(options.checkpoint, 'workspace'), join(stage, 'workspace'));
    renameSync(stage, options.destination);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

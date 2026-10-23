import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { LocalRepositoryReadAccess } from './local-repository-read-access.js';
import { readLocalRepositorySnapshotStatus } from './local-repository-git-snapshot.js';

const execute = promisify(execFile);
const env = {
  PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
};
const credentialDirectories = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.azure',
  '.gcloud',
  'Keychains',
]);
const agentDirectories = new Set(['.claude', '.cursor', '.codex']);
/** Static restrictions only; no filesystem probes or authority grants. */
export function localRepositoryReadDirectoryExclusions(directory: string) {
  return [...credentialDirectories, ...agentDirectories].map((name) => join(directory, name));
}
export function isLocalRepositoryCredentialPath(path: string) {
  const parts = resolve(path).split(sep);
  return parts.some(
    (part, index) =>
      credentialDirectories.has(part) ||
      (agentDirectories.has(part) && parts[index + 1] !== 'worktrees'),
  );
}
export interface LocalRepositoryGitInspectionRequest {
  path: string;
  /** Validate existing read authority; this callback must not grant access. */
  assertReadable: (path: string) => Promise<void>;
  signal?: AbortSignal;
  maxEntries?: number;
  timeoutMs?: number;
  /** Qualified private reader for product read-tools; legacy workspace preflight retains its own boundary. */
  readAccess?: LocalRepositoryReadAccess;
}
export interface LocalRepositoryComparisonConfig {
  readonly coreAutocrlf?: boolean | 'input';
  readonly coreFileMode?: boolean;
  /** Retain repository facts, but do not report authoritative status. */
  readonly unsupported?: true;
}
export interface LocalRepositoryGitMetadata {
  path: string;
  gitDirectory: string;
  commonDirectory: string;
  objectFormat: 'sha1' | 'sha256';
  comparisonConfig: Readonly<LocalRepositoryComparisonConfig>;
}

export class LocalRepositoryGitInspectionError extends Error {
  constructor(
    public readonly kind: 'limit' | 'unsafe' | 'access',
    public readonly reason: string,
  ) {
    super(`Git metadata inspection ${reason}`);
    this.name = 'LocalRepositoryGitInspectionError';
  }
}

async function readRegular(path: string, maxBytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw Error('Git metadata is not a bounded regular file');
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw Error('Git metadata changed during inspection');
    return buffer;
  } finally {
    await file.close();
  }
}

function comparisonBoolean(value: string | undefined): boolean {
  if (value === undefined || ['true', 'yes', 'on', '1'].includes((value ?? 'true').toLowerCase()))
    return true;
  if (['', 'false', 'no', 'off', '0'].includes(value.toLowerCase())) return false;
  throw new LocalRepositoryGitInspectionError('unsafe', 'comparison-configuration-unsupported');
}
function comparisonConfig(
  common: readonly { key: string; value: string | undefined }[],
  worktree: readonly { key: string; value: string | undefined }[],
  omittedAttributes: boolean,
): Readonly<LocalRepositoryComparisonConfig> {
  const result: { coreAutocrlf?: boolean | 'input'; coreFileMode?: boolean; unsupported?: true } =
    {};
  try {
    let worktreeEnabled = false;
    for (const entry of common)
      if (entry.key === 'extensions.worktreeconfig')
        worktreeEnabled = comparisonBoolean(entry.value);
    // Git reads common config first. Linked admin/config is not local config,
    // and config.worktree is effective only with the common extension enabled.
    const effective = new Map(
      [...common, ...(worktreeEnabled ? worktree : [])].map(({ key, value }) => [key, value]),
    );
    if (effective.has('core.autocrlf')) {
      const value = effective.get('core.autocrlf');
      result.coreAutocrlf = value?.toLowerCase() === 'input' ? 'input' : comparisonBoolean(value);
    }
    if (effective.has('core.filemode'))
      result.coreFileMode = comparisonBoolean(effective.get('core.filemode'));
    // Omitted attributes and executable conversions are not neutral: a clean
    // filter may be non-idempotent. Never execute it or certify private-copy
    // equality under different conversion rules. External ignore data and
    // regular-file representations of index symlinks
    // cannot be silently dropped. Leave status unknown rather than read an
    // unapproved path or invent a broader comparison/configuration engine.
    if (
      omittedAttributes ||
      effective.has('core.attributesfile') ||
      [...effective.keys()].some((key) => key.startsWith('filter.')) ||
      effective.has('core.excludesfile') ||
      (effective.has('core.symlinks') && !comparisonBoolean(effective.get('core.symlinks')))
    )
      result.unsupported = true;
  } catch (error) {
    if (!(error instanceof LocalRepositoryGitInspectionError)) throw error;
    result.unsupported = true;
  }
  return Object.freeze(result);
}

/** Resolve and validate storage before any Git command can load repository configuration. */
export async function inspectLocalRepositoryGitMetadata(
  request: LocalRepositoryGitInspectionRequest,
): Promise<LocalRepositoryGitMetadata> {
  const deadline = Date.now() + Math.max(1, Math.min(request.timeoutMs ?? 5000, 30000));
  const check = () => {
    request.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new LocalRepositoryGitInspectionError('limit', 'timeout');
  };
  const authorize = async (path: string) => {
    check();
    try {
      await request.assertReadable(path);
      check();
    } catch (error) {
      request.signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
    }
  };
  const stat = async (path: string) => {
    if (!request.readAccess) return lstat(path);
    const value = await request.readAccess.stat(path);
    if (!value) throw Object.assign(Error('Git metadata unavailable'), { code: 'ENOENT' });
    return {
      isFile: () => value.kind === 'file',
      isDirectory: () => value.kind === 'directory',
      isSymbolicLink: () => value.kind === 'unsupported',
    };
  };
  const read = (path: string, limit: number) =>
    request.readAccess ? request.readAccess.read(path, limit) : readRegular(path, limit);
  const physical = async (path: string) => {
    check();
    if (request.readAccess && !request.readAccess.covers(path))
      await request.readAccess.pinRoot(path);
    if (!isAbsolute(path) || isLocalRepositoryCredentialPath(path))
      throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
    await authorize(path);
    if (
      (!request.readAccess && (await realpath(path)) !== path) ||
      (await stat(path)).isSymbolicLink()
    )
      throw new LocalRepositoryGitInspectionError('unsafe', 'symlinks-unavailable');
  };
  let path = resolve(request.path);
  let marker: Awaited<ReturnType<typeof stat>>;
  for (;;) {
    await physical(path);
    try {
      const markerPath = join(path, '.git');
      await authorize(markerPath);
      marker = await stat(markerPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
      if (request.readAccess) {
        const entries = await request.readAccess.list(path);
        if (
          entries.some((entry) => entry.name === 'HEAD' && entry.kind === 'file') &&
          entries.some((entry) => entry.name === 'config' && entry.kind === 'file') &&
          entries.some((entry) => entry.name === 'objects' && entry.kind === 'directory')
        )
          throw new LocalRepositoryGitInspectionError('unsafe', 'bare-repository-unsupported');
      }
      path = dirname(path);
    }
  }
  await request.readAccess?.pinRoot(path);
  if (marker.isSymbolicLink())
    throw new LocalRepositoryGitInspectionError('unsafe', 'symlinks-unavailable');
  let gitDirectory = join(path, '.git');
  await authorize(gitDirectory);
  if (marker.isFile()) {
    const text = (await read(gitDirectory, 4096)).toString('utf8');
    const match = /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(text);
    if (!match) throw Error('Git metadata pointer is invalid');
    gitDirectory = resolve(path, match[1]);
  } else if (!marker.isDirectory()) throw Error('Git metadata is unavailable');
  try {
    await request.readAccess?.pinRoot(gitDirectory);
    await physical(gitDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
      throw new LocalRepositoryGitInspectionError('unsafe', 'git-storage-unavailable');
    throw error;
  }
  let commonDirectory = gitDirectory;
  try {
    const commonFile = join(gitDirectory, 'commondir');
    await authorize(commonFile);
    const value = (await read(commonFile, 4096)).toString('utf8');
    if (!/^[^\r\n\0]+\r?\n?$/.test(value)) throw Error('Git common metadata pointer is invalid');
    commonDirectory = resolve(gitDirectory, value.trimEnd());
    try {
      await request.readAccess?.pinRoot(commonDirectory);
      await physical(commonDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        throw new LocalRepositoryGitInspectionError('unsafe', 'git-storage-unavailable');
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const pending = [...new Set([gitDirectory, commonDirectory])];
  const visited = new Set<string>();
  let entries = 0;
  let omittedAttributes = false;
  while (pending.length) {
    check();
    const directory = pending.pop()!;
    if (visited.has(directory)) continue;
    visited.add(directory);
    await physical(directory);
    const opened = request.readAccess
      ? (await request.readAccess.list(directory)).map((entry) => ({
          name: entry.name,
          isSymbolicLink: () => entry.kind === 'unsupported',
          isDirectory: () => entry.kind === 'directory',
        }))
      : await opendir(directory);
    for await (const entry of opened) {
      check();
      if (++entries > Math.max(1, Math.min(request.maxEntries ?? 100000, 500000)))
        throw new LocalRepositoryGitInspectionError('limit', 'entries');
      if (entry.isSymbolicLink())
        throw new LocalRepositoryGitInspectionError('unsafe', 'symlinks-unavailable');
      if (
        entry.name === 'attributes' &&
        [gitDirectory, commonDirectory].some((root) => directory === join(root, 'info'))
      )
        omittedAttributes = true;
      // These are never consumed by our read-only Git commands; submodules are ignored.
      if (entry.isDirectory() && !['hooks', 'logs', 'modules'].includes(entry.name))
        pending.push(join(directory, entry.name));
    }
  }
  let objectFormat: 'sha1' | 'sha256' = 'sha1';
  const parsedConfigs = new Map<string, Array<{ key: string; value: string | undefined }>>();
  for (const directory of new Set([gitDirectory, commonDirectory])) {
    for (const name of ['config', 'config.worktree']) {
      check();
      const config = join(directory, name);
      try {
        await authorize(config);
        const bytes = await read(config, 65536);
        // Parse bounded stdin with Git's grammar, outside any repository, without includes.
        const parser = execute(
          'git',
          ['config', '--no-includes', '--file', '-', '--null', '--list'],
          {
            cwd: '/',
            env,
            encoding: 'utf8',
            signal: request.signal,
            timeout: Math.max(1, deadline - Date.now()),
            maxBuffer: 131072,
          },
        );
        parser.child.stdin?.end(bytes);
        let stdout: string;
        try {
          ({ stdout } = await parser);
        } catch (error) {
          request.signal?.throwIfAborted();
          if (request.readAccess)
            throw new LocalRepositoryGitInspectionError(
              'unsafe',
              'configuration-parser-unavailable',
            );
          throw error;
        }
        await authorize(config);
        const parsed: Array<{ key: string; value: string | undefined }> = [];
        parsedConfigs.set(config, parsed);
        for (const entry of stdout.split('\0').filter(Boolean)) {
          const newline = entry.indexOf('\n');
          const key = entry.slice(0, newline === -1 ? undefined : newline).toLowerCase();
          const value = newline === -1 ? undefined : entry.slice(newline + 1);
          parsed.push({ key, value });
          if (/^include(if)?\./.test(key))
            throw new LocalRepositoryGitInspectionError(
              'unsafe',
              'included-configuration-unavailable',
            );
          if (
            key.startsWith('extensions.') &&
            !['extensions.objectformat', 'extensions.worktreeconfig'].includes(key)
          )
            throw new LocalRepositoryGitInspectionError(
              'unsafe',
              'configuration-extension-unsupported',
            );
          if (
            key === 'core.bare' &&
            ['true', 'yes', 'on', '1'].includes((value ?? 'true').toLowerCase())
          )
            throw new LocalRepositoryGitInspectionError('unsafe', 'bare-repository-unsupported');
          if (key === 'extensions.objectformat') {
            if (value !== 'sha1' && value !== 'sha256')
              throw new LocalRepositoryGitInspectionError('unsafe', 'object-format-unsupported');
            objectFormat = value;
          }
          if (
            key === 'core.worktree' &&
            (value === undefined || resolve(directory, value) !== path)
          )
            throw new LocalRepositoryGitInspectionError(
              'unsafe',
              'external-worktree-configuration',
            );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    for (const name of ['objects/info/alternates', 'objects/info/http-alternates']) {
      try {
        await authorize(join(directory, name));
        if ((await read(join(directory, name), 65536)).toString('utf8').trim())
          throw new LocalRepositoryGitInspectionError('unsafe', 'alternate-storage-unavailable');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  await authorize(path);
  return {
    path,
    gitDirectory,
    commonDirectory,
    objectFormat,
    comparisonConfig: comparisonConfig(
      parsedConfigs.get(join(commonDirectory, 'config')) ?? [],
      parsedConfigs.get(join(gitDirectory, 'config.worktree')) ?? [],
      omittedAttributes,
    ),
  };
}

/** Omitted host/global config, attributes and environment are not qualified by
 * repository-local metadata. Private equality cannot certify effective source
 * cleanliness. Keep product inspection conservative until an existing actual
 * owner can establish the complete comparison context. No caller flag grants it. */
export async function readLocalRepositoryStatus(
  metadata: LocalRepositoryGitMetadata,
  options: { signal?: AbortSignal; timeoutMs: number; readAccess: LocalRepositoryReadAccess },
): Promise<string> {
  options.signal?.throwIfAborted();
  await options.readAccess.assertPath(metadata.path);
  throw new LocalRepositoryGitInspectionError('unsafe', 'comparison-context-unqualified');
}

/** Internal isolated comparison only. This does not report source-effective
 * dirty/clean facts and is never exposed as a product tool or a grant. */
export async function readIsolatedLocalRepositoryStatus(
  metadata: LocalRepositoryGitMetadata,
  options: { signal?: AbortSignal; timeoutMs: number; readAccess: LocalRepositoryReadAccess },
): Promise<string> {
  return readLocalRepositorySnapshotStatus(metadata, options);
}

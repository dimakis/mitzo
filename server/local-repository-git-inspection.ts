import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

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
  /** Validated scalar semantics only; never source configuration bytes or executable settings. */
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
  if (value === undefined || ['true', 'yes', 'on', '1'].includes(value.toLowerCase())) return true;
  if (['', 'false', 'no', 'off', '0'].includes(value.toLowerCase())) return false;
  throw new LocalRepositoryGitInspectionError('unsafe', 'comparison-configuration-unsupported');
}
function comparisonConfig(
  common: readonly { key: string; value: string | undefined }[],
  worktree: readonly { key: string; value: string | undefined }[],
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
    // External ignore data and regular-file representations of index symlinks
    // cannot be silently dropped. Leave status unknown rather than read an
    // unapproved path or invent a broader comparison/configuration engine.
    if (
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
    } catch (error) {
      request.signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
    }
  };
  const physical = async (path: string) => {
    check();
    if (!isAbsolute(path) || isLocalRepositoryCredentialPath(path))
      throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
    await authorize(path);
    if ((await realpath(path)) !== path || (await lstat(path)).isSymbolicLink())
      throw new LocalRepositoryGitInspectionError('unsafe', 'symlinks-unavailable');
  };
  let path = resolve(request.path);
  let marker: Awaited<ReturnType<typeof lstat>>;
  for (;;) {
    await physical(path);
    try {
      const markerPath = join(path, '.git');
      await authorize(markerPath);
      marker = await lstat(markerPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
      path = dirname(path);
    }
  }
  if (marker.isSymbolicLink())
    throw new LocalRepositoryGitInspectionError('unsafe', 'symlinks-unavailable');
  let gitDirectory = join(path, '.git');
  await authorize(gitDirectory);
  if (marker.isFile()) {
    const text = (await readRegular(gitDirectory, 4096)).toString('utf8');
    const match = /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(text);
    if (!match) throw Error('Git metadata pointer is invalid');
    gitDirectory = resolve(path, match[1]);
  } else if (!marker.isDirectory()) throw Error('Git metadata is unavailable');
  await physical(gitDirectory);
  let commonDirectory = gitDirectory;
  try {
    const commonFile = join(gitDirectory, 'commondir');
    await authorize(commonFile);
    const value = (await readRegular(commonFile, 4096)).toString('utf8');
    if (!/^[^\r\n\0]+\r?\n?$/.test(value)) throw Error('Git common metadata pointer is invalid');
    commonDirectory = resolve(gitDirectory, value.trimEnd());
    await physical(commonDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const pending = [...new Set([gitDirectory, commonDirectory])];
  const visited = new Set<string>();
  let entries = 0;
  while (pending.length) {
    check();
    const directory = pending.pop()!;
    if (visited.has(directory)) continue;
    visited.add(directory);
    await physical(directory);
    const opened = await opendir(directory);
    for await (const entry of opened) {
      check();
      if (++entries > Math.max(1, Math.min(request.maxEntries ?? 100000, 500000)))
        throw new LocalRepositoryGitInspectionError('limit', 'entries');
      if (entry.isSymbolicLink())
        throw new LocalRepositoryGitInspectionError('unsafe', 'symlinks-unavailable');
      // These are never consumed by our read-only Git commands; submodules are ignored.
      if (entry.isDirectory() && !['hooks', 'logs', 'modules'].includes(entry.name))
        pending.push(join(directory, entry.name));
    }
  }
  const parsedConfigs = new Map<string, Array<{ key: string; value: string | undefined }>>();
  for (const directory of new Set([gitDirectory, commonDirectory])) {
    for (const name of ['config', 'config.worktree']) {
      check();
      const config = join(directory, name);
      try {
        await authorize(config);
        const bytes = await readRegular(config, 65536);
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
        const { stdout } = await parser;
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
        if ((await readRegular(join(directory, name), 65536)).toString('utf8').trim())
          throw new LocalRepositoryGitInspectionError('unsafe', 'alternate-storage-unavailable');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return {
    path,
    gitDirectory,
    commonDirectory,
    comparisonConfig: comparisonConfig(
      parsedConfigs.get(join(commonDirectory, 'config')) ?? [],
      parsedConfigs.get(join(gitDirectory, 'config.worktree')) ?? [],
    ),
  };
}

/** Uses the established private Git-directory inspection pattern, never source filters/config. */
export async function readLocalRepositoryStatus(
  metadata: LocalRepositoryGitMetadata,
  options: {
    signal?: AbortSignal;
    timeoutMs: number;
    assertReadable: (path: string) => Promise<void>;
  },
): Promise<string> {
  if (metadata.comparisonConfig.unsupported)
    throw new LocalRepositoryGitInspectionError('unsafe', 'comparison-configuration-unsupported');
  const deadline = Date.now() + options.timeoutMs;
  const run = async (args: string[], extraEnv = {}) =>
    (
      await execute('git', args, {
        env: { ...env, ...extraEnv },
        signal: options.signal,
        timeout: Math.max(1, deadline - Date.now()),
        maxBuffer: 262144,
        encoding: 'utf8',
      })
    ).stdout;
  const format = (await run(['-C', metadata.path, 'rev-parse', '--show-object-format'])).trim();
  if (!['sha1', 'sha256'].includes(format)) throw Error('Unsupported Git object format');
  const scratch = await mkdtemp(join(tmpdir(), 'mitzo-git-inspection-'));
  try {
    await run([
      'init',
      '--quiet',
      '--template=',
      '--initial-branch=mitzo-inspect',
      `--object-format=${format}`,
      scratch,
    ]);
    const gitDirectory = join(scratch, '.git');
    await writeFile(
      join(gitDirectory, 'HEAD'),
      await readRegular(join(metadata.gitDirectory, 'HEAD'), 4096),
    );
    // Copy the index, never source config, hooks, attributes, credentials or worktree metadata.
    try {
      await writeFile(
        join(gitDirectory, 'index'),
        await readRegular(join(metadata.gitDirectory, 'index'), 16 * 1024 * 1024),
      );
      // A newer scratch timestamp can hide same-size edits within the source
      // index's racy-clean window. A nonzero old timestamp forces Git to rehash
      // cached file entries; zero disables Git's racy-timestamp check.
      await utimes(join(gitDirectory, 'index'), 1, 1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // info/exclude is data, not executable configuration. Preserve bounded,
    // currently authorized common-worktree rules so ignored names stay private.
    const exclude = join(metadata.commonDirectory, 'info', 'exclude');
    try {
      await options.assertReadable(exclude);
      const rules = await readRegular(exclude, 65536);
      options.signal?.throwIfAborted();
      await options.assertReadable(exclude);
      await mkdir(join(gitDirectory, 'info'), { recursive: true });
      await writeFile(join(gitDirectory, 'info', 'exclude'), rules, { mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Resolve the original HEAD to an OID so the private directory needs no source refs.
    try {
      const head = (await run(['-C', metadata.path, 'rev-parse', '--verify', 'HEAD'])).trim();
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) throw Error('Invalid Git HEAD');
      await writeFile(join(gitDirectory, 'HEAD'), head + '\n');
    } catch (error) {
      if ((error as { code?: unknown }).code !== 128) throw error;
    }
    return await run(
      [
        '-C',
        metadata.path,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...(metadata.comparisonConfig.coreAutocrlf !== undefined
          ? ['-c', `core.autocrlf=${metadata.comparisonConfig.coreAutocrlf}`]
          : []),
        ...(metadata.comparisonConfig.coreFileMode !== undefined
          ? ['-c', `core.filemode=${metadata.comparisonConfig.coreFileMode}`]
          : []),
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=normal',
        '--ignore-submodules=all',
      ],
      {
        GIT_DIR: gitDirectory,
        GIT_WORK_TREE: metadata.path,
        GIT_OBJECT_DIRECTORY: join(metadata.commonDirectory, 'objects'),
      },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  inspectLocalRepositoryGitMetadata,
  isLocalRepositoryCredentialPath,
  LocalRepositoryGitInspectionError,
  readLocalRepositoryStatus,
  type LocalRepositoryGitMetadata,
} from './local-repository-git-inspection.js';

/** A projection of existing target read access, never a request to grant access. */
export type LocalRepositoryReadScope =
  { kind: 'roots'; roots: readonly string[] } | { kind: 'host-wide' };
export interface LocalRepositoryLimits {
  maxDirectories?: number;
  maxEntries?: number;
  maxGitMetadataEntries?: number;
  maxDepth?: number;
  maxCandidates?: number;
  timeoutMs?: number;
  maxInstructionBytes?: number;
  maxTotalInstructionBytes?: number;
  maxInstructionDirectories?: number;
}
interface ReadRequest {
  accessScope: LocalRepositoryReadScope;
  limits?: LocalRepositoryLimits;
  signal?: AbortSignal;
}
export interface LocalRepositoryDiscoveryRequest extends ReadRequest {
  query?: string;
  explicitPath?: string;
  /** Bounded search locations, independent of the target's actual access scope. */
  discoveryRoots?: readonly string[];
  /** Ordering hints only: these neither grant access nor resolve ambiguity. */
  orientationHints?: readonly string[];
}
export interface LocalRepositoryCandidate {
  name: string;
  path: string;
}
export interface LocalRepositoryDiagnostic {
  path: string;
  reason: string;
}
export interface LocalRepositoryDiscoveryResult {
  state: 'selected' | 'ambiguous' | 'missing' | 'access-required';
  candidates: LocalRepositoryCandidate[];
  truncated: boolean;
  limitReasons: string[];
  diagnostics: LocalRepositoryDiagnostic[];
  needed: Array<
    | 'source'
    | 'destination'
    | 'query-or-path'
    | 'read-access'
    | 'discovery-roots'
    | 'narrower-search'
  >;
  visitedDirectories: number;
}
export interface LocalRepositoryInspection {
  path: string;
  cwd: string;
  head: string | null;
  branch: string | null;
  gitDirectory: string;
  commonDirectory: string;
  /** Git facts only; session ownership must still be checked by the workspace owner. */
  worktrees: Array<{
    path: string;
    head?: string;
    branch?: string;
    locked?: boolean;
    prunable?: boolean;
  }>;
  dirty: {
    state: 'clean' | 'dirty' | 'unknown';
    entries: Array<{ path: string; index: string; worktree: string; originalPath?: string }>;
  };
  instructions: {
    files: Array<{
      path: string;
      resolvedPath: string;
      identity: { dev: number; ino: number };
      content: string;
      truncated: boolean;
    }>;
    omitted: LocalRepositoryDiagnostic[];
    complete: boolean;
  };
  diagnostics: LocalRepositoryDiagnostic[];
}

const execute = promisify(execFile);
const credentials = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.azure',
  '.gcloud',
  '.codex',
  '.claude',
  '.cursor',
  '.config',
  'Keychains',
]);
const skipped = new Set([
  ...credentials,
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.npm',
  '.yarn',
  '.pnpm-store',
  '.next',
  'Library',
]);
const within = (path: string, root: string) => {
  const suffix = relative(root, path);
  return (
    suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
  );
};
const credentialPath = isLocalRepositoryCredentialPath;
const integer = (value: number | undefined, fallback: number, ceiling: number) =>
  value !== undefined && Number.isFinite(value)
    ? Math.max(1, Math.min(ceiling, Math.floor(value)))
    : fallback;
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

async function context(request: ReadRequest) {
  request.signal?.throwIfAborted();
  const limits = {
    maxDirectories: integer(request.limits?.maxDirectories, 2000, 10000),
    maxEntries: integer(request.limits?.maxEntries, 20000, 100000),
    maxGitMetadataEntries: integer(request.limits?.maxGitMetadataEntries, 100000, 500000),
    maxDepth: integer(request.limits?.maxDepth, 6, 20),
    maxCandidates: integer(request.limits?.maxCandidates, 20, 100),
    timeoutMs: integer(request.limits?.timeoutMs, 5000, 30000),
    maxInstructionBytes: integer(request.limits?.maxInstructionBytes, 65536, 262144),
    maxTotalInstructionBytes: integer(request.limits?.maxTotalInstructionBytes, 262144, 1048576),
    maxInstructionDirectories: integer(request.limits?.maxInstructionDirectories, 32, 128),
  };
  const deadline = Date.now() + limits.timeoutMs;
  const roots: string[] = [];
  const diagnostics: LocalRepositoryDiagnostic[] = [];
  if (request.accessScope.kind === 'roots') {
    for (const root of request.accessScope.roots) {
      request.signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new LocalRepositoryGitInspectionError('limit', 'timeout');
      if (!isAbsolute(root)) {
        diagnostics.push({ path: root, reason: 'absolute-path-required' });
        continue;
      }
      try {
        roots.push(await realpath(root));
      } catch {
        diagnostics.push({ path: root, reason: 'unavailable-access-root' });
      }
    }
  }
  const allowed = (path: string) =>
    !credentialPath(path) &&
    (request.accessScope.kind === 'host-wide' || roots.some((root) => within(path, root)));
  const check = () => {
    request.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new LocalRepositoryGitInspectionError('limit', 'timeout');
  };
  const canonical = async (path: string) => {
    check();
    if (!isAbsolute(path))
      throw new LocalRepositoryGitInspectionError('access', 'absolute-path-required');
    if (credentialPath(path))
      throw new LocalRepositoryGitInspectionError('access', 'credential-directory-excluded');
    const result = await realpath(path);
    if (!allowed(result))
      throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
    return result;
  };
  const git = async (cwd: string, ...args: string[]) => {
    check();
    await metadata(cwd);
    const result = await execute(
      'git',
      [
        '--no-replace-objects',
        '-C',
        cwd,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      {
        encoding: 'utf8',
        timeout: Math.max(1, deadline - Date.now()),
        maxBuffer: 262144,
        signal: request.signal,
        // Exclude inherited Git overrides, credentials and repository-selected hooks.
        env: {
          PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_NO_LAZY_FETCH: '1',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
    return result.stdout;
  };
  const inspected = new Map<string, LocalRepositoryGitMetadata>();
  const metadata = async (cwd: string) => {
    if (!inspected.has(cwd)) {
      inspected.set(
        cwd,
        await inspectLocalRepositoryGitMetadata({
          path: cwd,
          assertReadable: async (path) => {
            await canonical(path);
          },
          signal: request.signal,
          maxEntries: limits.maxGitMetadataEntries,
          timeoutMs: Math.max(1, deadline - Date.now()),
        }),
      );
    }
    return inspected.get(cwd)!;
  };
  return { roots, limits, deadline, diagnostics, allowed, check, canonical, git, metadata };
}

/** Read-only bounded discovery. A partial scan never silently chooses a unique match. */
export async function discoverLocalRepository(
  request: LocalRepositoryDiscoveryRequest,
): Promise<LocalRepositoryDiscoveryResult> {
  const ctx = await context(request);
  const result: LocalRepositoryDiscoveryResult = {
    state: 'missing',
    candidates: [],
    truncated: false,
    limitReasons: [],
    diagnostics: ctx.diagnostics,
    needed: [],
    visitedDirectories: 0,
  };
  const limit = (reason: string) => {
    result.truncated = true;
    if (!result.limitReasons.includes(reason)) result.limitReasons.push(reason);
  };
  const candidate = async (path: string) => {
    const top = await ctx.canonical((await ctx.git(path, 'rev-parse', '--show-toplevel')).trim());
    if (!result.candidates.some((entry) => entry.path === top))
      result.candidates.push({ name: basename(top), path: top });
  };
  if (request.explicitPath) {
    try {
      await candidate(await ctx.canonical(request.explicitPath));
      result.state = 'selected';
    } catch (error) {
      request.signal?.throwIfAborted();
      const missing = errorCode(error) === 'ENOENT';
      const limited = error instanceof LocalRepositoryGitInspectionError && error.kind === 'limit';
      const access = error instanceof LocalRepositoryGitInspectionError && error.kind === 'access';
      if (limited) limit(`git-metadata-${error.reason}`);
      result.state = missing ? 'missing' : access ? 'access-required' : 'ambiguous';
      result.needed = missing
        ? ['source', 'destination']
        : limited
          ? ['narrower-search']
          : access
            ? ['read-access']
            : [];
      result.diagnostics.push({
        path: request.explicitPath,
        reason: missing
          ? 'repository-not-found'
          : limited
            ? 'inspection-limit'
            : access
              ? 'read-access-required'
              : 'inspection-unavailable',
      });
    }
    return result;
  }
  const query = request.query?.trim().toLocaleLowerCase();
  if (!query) {
    result.needed = ['query-or-path'];
    return result;
  }
  const scanRoots =
    request.discoveryRoots ?? (request.accessScope.kind === 'roots' ? ctx.roots : []);
  if (!scanRoots.length || scanRoots.some((root) => resolve(root) === sep)) {
    result.state = 'access-required';
    result.needed = ['discovery-roots'];
    return result;
  }
  const hints = request.orientationHints ?? [];
  const queue: Array<{ path: string; depth: number }> = [];
  for (const path of scanRoots) {
    try {
      queue.push({ path: await ctx.canonical(path), depth: 0 });
    } catch {
      request.signal?.throwIfAborted();
      result.diagnostics.push({ path, reason: 'read-access-required' });
    }
  }
  queue.sort(
    (a, b) =>
      Number(hints.includes(b.path)) - Number(hints.includes(a.path)) ||
      a.path.localeCompare(b.path),
  );
  const visited = new Set<string>();
  let entries = 0;
  while (queue.length) {
    request.signal?.throwIfAborted();
    if (Date.now() >= ctx.deadline) {
      limit('timeout');
      break;
    }
    if (result.visitedDirectories >= ctx.limits.maxDirectories) {
      limit('directories');
      break;
    }
    const current = queue.shift()!;
    if (visited.has(current.path)) continue;
    visited.add(current.path);
    result.visitedDirectories++;
    try {
      if ((await ctx.canonical(current.path)) !== current.path)
        throw Error('Discovery path changed');
      const marker = await lstat(join(current.path, '.git')).catch(() => null);
      if (
        marker &&
        !marker.isSymbolicLink() &&
        (marker.isFile() || marker.isDirectory()) &&
        basename(current.path).toLocaleLowerCase().includes(query)
      ) {
        await candidate(current.path);
        if (result.candidates.length >= ctx.limits.maxCandidates) {
          limit('candidates');
          break;
        }
      }
      const directory = await opendir(current.path);
      for await (const entry of directory) {
        request.signal?.throwIfAborted();
        if (++entries > ctx.limits.maxEntries) {
          limit('entries');
          break;
        }
        if (Date.now() >= ctx.deadline) {
          limit('timeout');
          break;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink() || skipped.has(entry.name)) continue;
        if (current.depth >= ctx.limits.maxDepth) {
          limit('depth');
          continue;
        }
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
      }
      if (result.limitReasons.includes('entries') || result.limitReasons.includes('timeout')) break;
    } catch (error) {
      request.signal?.throwIfAborted();
      if (error instanceof LocalRepositoryGitInspectionError && error.kind === 'limit')
        limit(`git-metadata-${error.reason}`);
      result.diagnostics.push({
        path: current.path,
        reason:
          error instanceof LocalRepositoryGitInspectionError && error.kind === 'access'
            ? 'read-access-required'
            : 'inspection-unavailable',
      });
    }
  }
  const exact = result.candidates.filter((entry) => entry.name.toLocaleLowerCase() === query);
  if (exact.length) result.candidates = exact;
  result.candidates.sort(
    (a, b) =>
      Number(hints.includes(b.path)) - Number(hints.includes(a.path)) ||
      a.path.localeCompare(b.path),
  );
  if (result.candidates.length) {
    result.state =
      result.candidates.length === 1 && !result.truncated && !result.diagnostics.length
        ? 'selected'
        : 'ambiguous';
    if (result.truncated) result.needed = ['narrower-search'];
  } else if (result.truncated) {
    result.state = 'ambiguous';
    result.needed = ['narrower-search'];
  } else if (result.diagnostics.length) {
    const access = result.diagnostics.some(
      (diagnostic) => diagnostic.reason === 'read-access-required',
    );
    result.state = access ? 'access-required' : 'ambiguous';
    result.needed = access ? ['read-access'] : [];
  } else result.needed = ['source', 'destination'];
  return result;
}

/** Inspect facts only. No stash, reset, checkout, fetch, allocation or ownership claim. */
export async function inspectLocalRepository(
  request: ReadRequest & { path: string },
): Promise<LocalRepositoryInspection> {
  const ctx = await context(request);
  const cwd = await ctx.canonical(request.path);
  const metadata = await ctx.metadata(cwd);
  const path = await ctx.canonical((await ctx.git(cwd, 'rev-parse', '--show-toplevel')).trim());
  const gitDirectory = (await ctx.git(path, 'rev-parse', '--absolute-git-dir')).trim();
  const commonDirectory = (
    await ctx.git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  ).trim();
  const branch = (await ctx.git(path, 'branch', '--show-current')).trim() || null;
  let head: string | null = null;
  try {
    head = (await ctx.git(path, 'rev-parse', '--verify', 'HEAD')).trim();
  } catch {
    request.signal?.throwIfAborted(); /* Unborn repository. */
  }
  const diagnostics = ctx.diagnostics;
  const dirty: LocalRepositoryInspection['dirty'] = { state: 'unknown', entries: [] };
  try {
    const entries = (
      await readLocalRepositoryStatus(metadata, {
        signal: request.signal,
        timeoutMs: Math.max(1, ctx.deadline - Date.now()),
      })
    ).split('\0');
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (!entry) continue;
      dirty.entries.push({
        path: entry.slice(3),
        index: entry[0],
        worktree: entry[1],
        ...(/[RC]/.test(entry.slice(0, 2)) ? { originalPath: entries[++index] } : {}),
      });
    }
    dirty.state = dirty.entries.length ? 'dirty' : 'clean';
  } catch {
    request.signal?.throwIfAborted();
    diagnostics.push({ path, reason: 'dirty-state-unavailable' });
  }
  const worktrees: LocalRepositoryInspection['worktrees'] = [];
  try {
    const records = (await ctx.git(path, 'worktree', 'list', '--porcelain', '-z')).split('\0\0');
    for (const record of records) {
      const fields = record.split('\0');
      const entry = fields.find((field) => field.startsWith('worktree '));
      if (!entry) continue;
      const field = (name: string) =>
        fields.find((item) => item.startsWith(`${name} `))?.slice(name.length + 1);
      worktrees.push({
        path: entry.slice(9),
        head: field('HEAD'),
        branch: field('branch'),
        locked: fields.some((item) => item === 'locked' || item.startsWith('locked ')),
        prunable: fields.some((item) => item === 'prunable' || item.startsWith('prunable ')),
      });
    }
  } catch {
    request.signal?.throwIfAborted();
    diagnostics.push({ path, reason: 'worktrees-unavailable' });
  }
  const instructions: LocalRepositoryInspection['instructions'] = {
    files: [],
    omitted: [],
    complete: true,
  };
  const directories: string[] = [];
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (directories.length >= ctx.limits.maxInstructionDirectories) {
      instructions.omitted.push({ path: directory, reason: 'directory-limit' });
      break;
    }
    directories.unshift(directory);
    if (directory === dirname(directory)) break;
  }
  let remaining = ctx.limits.maxTotalInstructionBytes;
  for (const directory of directories) {
    if (!ctx.allowed(directory)) {
      instructions.omitted.push({ path: directory, reason: 'outside-access' });
      continue;
    }
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = join(directory, name);
      if (Date.now() >= ctx.deadline) {
        instructions.omitted.push({ path: file, reason: 'timeout' });
        continue;
      }
      request.signal?.throwIfAborted();
      try {
        const stat = await lstat(file);
        if (!stat.isFile() && !stat.isSymbolicLink()) {
          instructions.omitted.push({ path: file, reason: 'not-regular-file' });
          continue;
        }
        let resolvedPath: string;
        try {
          resolvedPath = await ctx.canonical(file);
        } catch (error) {
          request.signal?.throwIfAborted();
          if (!stat.isSymbolicLink()) throw error;
          instructions.omitted.push({ path: file, reason: 'symlink' });
          continue;
        }
        if (remaining <= 0) {
          instructions.omitted.push({ path: file, reason: 'byte-limit' });
          continue;
        }
        // O_NOFOLLOW closes the final-component symlink race; fstat rejects special files.
        const handle = await open(
          resolvedPath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const opened = await handle.stat();
          if (!opened.isFile()) {
            instructions.omitted.push({ path: file, reason: 'not-regular-file' });
            continue;
          }
          if ((await realpath(file)) !== resolvedPath) {
            instructions.omitted.push({ path: file, reason: 'changed-during-read' });
            continue;
          }
          const cap = Math.min(remaining, ctx.limits.maxInstructionBytes);
          const buffer = Buffer.alloc(Math.min(opened.size, cap));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const truncated = opened.size > bytesRead;
          remaining -= bytesRead;
          instructions.files.push({
            path: file,
            resolvedPath,
            identity: { dev: opened.dev, ino: opened.ino },
            content: buffer.subarray(0, bytesRead).toString('utf8'),
            truncated,
          });
        } finally {
          await handle.close();
        }
      } catch (error) {
        request.signal?.throwIfAborted();
        if (errorCode(error) !== 'ENOENT')
          instructions.omitted.push({ path: file, reason: 'read-unavailable' });
      }
    }
  }
  instructions.complete =
    !instructions.omitted.length && !instructions.files.some((file) => file.truncated);
  return {
    path,
    cwd,
    head,
    branch,
    gitDirectory,
    commonDirectory,
    worktrees,
    dirty,
    instructions,
    diagnostics,
  };
}

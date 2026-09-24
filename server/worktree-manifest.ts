import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';

const DEFAULT_RECENT_HOURS = 7 * 24;
const MAX_HASH_BYTES = 64 * 1024 * 1024;
const WORKTREE_ROOTS = ['.claude/worktrees', '.Codex/worktrees', '.cursor/worktrees'] as const;

export type WorktreeGitState = 'clean' | 'dirty' | 'unknown';
export type WorktreeFileKind = 'staged' | 'modified' | 'untracked' | 'ignored';
export type WorktreeProposedAction = 'preserve' | 'review-for-recovery' | 'review-for-cleanup';

export interface WorktreePullRequestEvidence {
  repository: string;
  headRefName: string;
  number: number;
  url: string;
  state: string;
}

export interface WorktreeFileEvidence {
  path: string;
  kinds: WorktreeFileKind[];
  sizeBytes: number | null;
  sha256?: string;
  hashStatus: 'hashed' | 'directory' | 'symlink' | 'sensitive' | 'too-large' | 'unreadable';
}

export interface WorktreeManifestEntry {
  sessionId: string;
  repository: string;
  path: string;
  location: 'managed' | 'registered-external' | 'primary';
  registered: boolean;
  branch: string | null;
  head: string | null;
  ageHours: number | null;
  diskBytes: number | null;
  gitState: WorktreeGitState;
  files: WorktreeFileEvidence[];
  noticeIds: string[];
  sessionSignals: {
    active: boolean;
    marker: boolean;
  };
  reachability: {
    baseRef: string;
    mergedToBase: boolean | null;
    remoteBranchesContainingHead: string[];
    pullRequests: Array<{ number: number; url: string; state: string }>;
    pullRequestLookup: 'complete' | 'unavailable' | 'not-requested';
  };
  proposedAction: WorktreeProposedAction;
  protectionReasons: string[];
  recoveryLocation: string | null;
}

export interface WorktreeManifest {
  schemaVersion: 1;
  generatedAt: string;
  readOnly: true;
  repositories: string[];
  repositoryResults: Array<{
    repository: string;
    status: 'scanned' | 'unavailable';
    error?: 'path-not-found' | 'not-a-git-repository';
    entries: number;
  }>;
  entries: WorktreeManifestEntry[];
}

export interface GenerateWorktreeManifestOptions {
  repositories: string[];
  inboxDirectories?: string[];
  activeSessionIds?: ReadonlySet<string>;
  now?: Date;
  recentHours?: number;
  baseRef?: string;
  pullRequests?: readonly WorktreePullRequestEvidence[];
  pullRequestLookupByRepository?: ReadonlyMap<string, 'complete' | 'unavailable'>;
  includeRegisteredOutsideManagedRoots?: boolean;
}

function git(repository: string, args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

function registeredWorktrees(repository: string): Set<string> {
  try {
    const records = git(repository, ['worktree', 'list', '--porcelain']);
    return new Set(
      records
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => {
          const path = resolve(line.slice('worktree '.length));
          try {
            return realpathSync(path);
          } catch {
            return path;
          }
        }),
    );
  } catch {
    return new Set();
  }
}

function listPhysicalWorktrees(repository: string): string[] {
  const paths: string[] = [];
  for (const root of WORKTREE_ROOTS) {
    const directory = join(repository, root);
    if (!existsSync(directory)) continue;
    try {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        try {
          if (lstatSync(path).isDirectory()) paths.push(realpathSync(path));
        } catch {
          // A concurrently disappearing entry is omitted from this snapshot.
        }
      }
    } catch {
      // An unreadable root contributes no entries; individual repositories remain isolated.
    }
  }
  return [...new Set(paths)].sort();
}

function directorySize(path: string): number | null {
  try {
    const output = execFileSync('du', ['-sk', path], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const kibibytes = Number.parseInt(output.trim().split(/\s+/)[0] ?? '', 10);
    return Number.isFinite(kibibytes) ? kibibytes * 1024 : null;
  } catch {
    return null;
  }
}

function sensitivePath(path: string): boolean {
  const parts = path.toLowerCase().split(/[\\/]/);
  const name = parts.at(-1) ?? '';
  return (
    parts.some((part) => ['.ssh', '.gnupg', '.aws', '.venv', 'node_modules'].includes(part)) ||
    name === '.env' ||
    name.startsWith('.env.') ||
    /(?:credential|secret|private[-_.]?key)/i.test(path) ||
    /\.(?:pem|p12|pfx|key)$/i.test(name)
  );
}

function fileEvidence(
  worktree: string,
  path: string,
  kinds: WorktreeFileKind[],
): WorktreeFileEvidence {
  const absolute = resolve(worktree, path);
  const inside = absolute === worktree || absolute.startsWith(`${worktree}${sep}`);
  if (!inside || sensitivePath(path)) {
    return { path, kinds, sizeBytes: null, hashStatus: 'sensitive' };
  }
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return { path, kinds, sizeBytes: stat.size, hashStatus: 'symlink' };
    if (stat.isDirectory()) return { path, kinds, sizeBytes: stat.size, hashStatus: 'directory' };
    if (!stat.isFile()) return { path, kinds, sizeBytes: stat.size, hashStatus: 'unreadable' };
    if (stat.size > MAX_HASH_BYTES) {
      return { path, kinds, sizeBytes: stat.size, hashStatus: 'too-large' };
    }
    return {
      path,
      kinds,
      sizeBytes: stat.size,
      sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
      hashStatus: 'hashed',
    };
  } catch {
    return { path, kinds, sizeBytes: null, hashStatus: 'unreadable' };
  }
}

function statusEvidence(worktree: string): {
  state: WorktreeGitState;
  files: WorktreeFileEvidence[];
} {
  try {
    const output = git(worktree, [
      'status',
      '--porcelain=v1',
      '-z',
      '--ignored=matching',
      '--untracked-files=all',
    ]);
    const records = output.split('\0');
    const files: WorktreeFileEvidence[] = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record) continue;
      const code = record.slice(0, 2);
      const path = record.slice(3);
      const kinds: WorktreeFileKind[] = [];
      if (code === '??') kinds.push('untracked');
      else if (code === '!!') kinds.push('ignored');
      else {
        if (code[0] !== ' ') kinds.push('staged');
        if (code[1] !== ' ') kinds.push('modified');
      }
      files.push(fileEvidence(worktree, path, kinds));
      if (code.includes('R') || code.includes('C')) index++;
    }
    return {
      state: files.some((file) => !file.kinds.includes('ignored')) ? 'dirty' : 'clean',
      files,
    };
  } catch {
    return { state: 'unknown', files: [] };
  }
}

function branchAndHead(worktree: string): { branch: string | null; head: string | null } {
  try {
    const head = git(worktree, ['rev-parse', 'HEAD']).trim();
    const branch = git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim() || null;
    return { branch, head };
  } catch {
    try {
      return { branch: null, head: git(worktree, ['rev-parse', 'HEAD']).trim() || null };
    } catch {
      return { branch: null, head: null };
    }
  }
}

function reachability(
  repository: string,
  branch: string | null,
  head: string | null,
  baseRef: string,
  pullRequests?: readonly WorktreePullRequestEvidence[],
  pullRequestLookup: 'complete' | 'unavailable' | 'not-requested' = 'not-requested',
): WorktreeManifestEntry['reachability'] {
  let mergedToBase: boolean | null = null;
  let remoteBranchesContainingHead: string[] = [];
  if (head) {
    try {
      execFileSync('git', ['-C', repository, 'merge-base', '--is-ancestor', head, baseRef], {
        stdio: 'pipe',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });
      mergedToBase = true;
    } catch (err: unknown) {
      const status =
        typeof err === 'object' && err !== null && 'status' in err ? Number(err.status) : null;
      mergedToBase = status === 1 ? false : null;
    }
    try {
      remoteBranchesContainingHead = git(repository, [
        'branch',
        '-r',
        '--contains',
        head,
        '--format=%(refname:short)',
      ])
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .sort();
    } catch {
      remoteBranchesContainingHead = [];
    }
  }
  return {
    baseRef,
    mergedToBase,
    remoteBranchesContainingHead,
    pullRequests: branch
      ? (pullRequests ?? [])
          .filter(
            (pullRequest) =>
              resolve(pullRequest.repository) === repository && pullRequest.headRefName === branch,
          )
          .map(({ number, url, state }) => ({ number, url, state }))
      : [],
    pullRequestLookup,
  };
}

function noticeIndex(inboxDirectories: string[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const visit = (directory: string, root: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        visit(path, root);
        continue;
      }
      if (!stat.isFile() || !name.endsWith('.md')) continue;
      const body = readFileSync(path, 'utf8');
      const id = relative(root, path);
      const filenameMatch = name.match(/_worktree_gc_(.+)\.md$/);
      const pathMatch = body.match(/^\*\*Path:\*\*\s+(.+)$/m);
      for (const key of [filenameMatch?.[1], pathMatch?.[1] ? resolve(pathMatch[1]) : undefined]) {
        if (!key) continue;
        const ids = result.get(key) ?? new Set<string>();
        ids.add(id);
        result.set(key, ids);
      }
    }
  };
  for (const directory of inboxDirectories) {
    if (!existsSync(directory)) continue;
    try {
      visit(directory, directory);
    } catch {
      // Manifest generation remains useful when a separate notice tree is unreadable.
    }
  }
  return result;
}

export function generateWorktreeManifest(
  options: GenerateWorktreeManifestOptions,
): WorktreeManifest {
  const now = options.now ?? new Date();
  const recentHours = options.recentHours ?? DEFAULT_RECENT_HOURS;
  const baseRef = options.baseRef ?? 'origin/main';
  const repositories = options.repositories.map((repository) => {
    const absolute = resolve(repository);
    try {
      return realpathSync(absolute);
    } catch {
      return absolute;
    }
  });
  const notices = noticeIndex(options.inboxDirectories ?? []);
  const entries: WorktreeManifestEntry[] = [];
  const repositoryResults: WorktreeManifest['repositoryResults'] = [];

  for (const repository of repositories) {
    if (!existsSync(repository)) {
      repositoryResults.push({
        repository,
        status: 'unavailable',
        error: 'path-not-found',
        entries: 0,
      });
      continue;
    }
    try {
      if (git(repository, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
        throw new Error('not a worktree');
      }
    } catch {
      repositoryResults.push({
        repository,
        status: 'unavailable',
        error: 'not-a-git-repository',
        entries: 0,
      });
      continue;
    }
    const entryCountBefore = entries.length;
    const registered = registeredWorktrees(repository);
    const managedPaths = new Set(listPhysicalWorktrees(repository));
    const paths = new Set(managedPaths);
    if (options.includeRegisteredOutsideManagedRoots) {
      for (const path of registered) {
        try {
          if (lstatSync(path).isDirectory()) paths.add(path);
        } catch {
          // Missing registered paths are metadata-only and not physical worktrees.
        }
      }
    }
    for (const path of [...paths].sort()) {
      const sessionId = basename(path);
      const isRegistered = registered.has(path);
      const location: WorktreeManifestEntry['location'] = managedPaths.has(path)
        ? 'managed'
        : path === repository
          ? 'primary'
          : 'registered-external';
      const marker = existsSync(join(path, '.mitzo-session'));
      const active = options.activeSessionIds?.has(sessionId) ?? false;
      let ageHours: number | null = null;
      let diskBytes: number | null = null;
      try {
        ageHours = Math.max(0, now.getTime() - statSync(path).mtimeMs) / 3_600_000;
        diskBytes = location === 'primary' ? null : directorySize(path);
      } catch {
        // Preserve null evidence if the entry disappears during inspection.
      }

      const identity = isRegistered ? branchAndHead(path) : { branch: null, head: null };
      const status = isRegistered ? statusEvidence(path) : { state: 'unknown' as const, files: [] };
      const protectionReasons: string[] = [];
      if (!isRegistered) protectionReasons.push('unregistered-directory');
      if (location === 'primary') protectionReasons.push('primary-checkout');
      if (location === 'registered-external') protectionReasons.push('outside-managed-root');
      if (active) protectionReasons.push('active-session');
      if (marker) protectionReasons.push('session-marker');
      if (ageHours === null || ageHours <= recentHours) protectionReasons.push('recent');
      if (status.state === 'dirty') protectionReasons.push('uncommitted-work');
      if (status.state === 'unknown' && isRegistered) protectionReasons.push('git-status-unknown');

      let proposedAction: WorktreeProposedAction = 'review-for-cleanup';
      if (protectionReasons.some((reason) => reason !== 'uncommitted-work')) {
        proposedAction = 'preserve';
      } else if (status.state === 'dirty') {
        proposedAction = 'review-for-recovery';
      }

      entries.push({
        sessionId,
        repository,
        path,
        location,
        registered: isRegistered,
        ...identity,
        ageHours,
        diskBytes,
        gitState: status.state,
        files: status.files,
        noticeIds: [...(notices.get(sessionId) ?? []), ...(notices.get(path) ?? [])]
          .filter((id, index, all) => all.indexOf(id) === index)
          .sort(),
        sessionSignals: { active, marker },
        reachability: reachability(
          repository,
          identity.branch,
          identity.head,
          baseRef,
          options.pullRequests,
          options.pullRequestLookupByRepository?.get(repository) ??
            (options.pullRequests ? 'complete' : 'not-requested'),
        ),
        proposedAction,
        protectionReasons,
        recoveryLocation: null,
      });
    }
    repositoryResults.push({
      repository,
      status: 'scanned',
      entries: entries.length - entryCountBefore,
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    readOnly: true,
    repositories,
    repositoryResults,
    entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function writeWorktreeManifest(manifest: WorktreeManifest, outputPath: string): void {
  const output = resolve(outputPath);
  const directory = dirname(output);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = join(directory, `.${basename(output)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, output);
  chmodSync(output, 0o600);
}

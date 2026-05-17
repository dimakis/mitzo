/* eslint no-empty: ["error", { allowEmptyCatch: true }] */
import { execFile as execFileCb, execFileSync } from 'child_process';
import { promisify } from 'util';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
} from 'fs';
import { mkdir } from 'fs/promises';
import { join, basename } from 'path';

const execFileAsync = promisify(execFileCb);
import {
  WORKTREE_BRANCH_PREFIX,
  WORKTREE_STALE_HOURS,
  WORKTREE_GIT_TIMEOUT_MS,
  WORKTREE_REMOVE_TIMEOUT_MS,
  WORKTREE_PRUNE_TIMEOUT_MS,
} from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('worktree');

/**
 * Detect the default branch of a repo (e.g. 'main' or 'master').
 * Prefers origin/HEAD (remote truth) since session worktrees should branch
 * from the canonical default, not whatever is locally checked out.
 * Falls back to 'main' (verified) or HEAD for repos without a remote.
 *
 * NOTE: Uses execFileSync intentionally — called during session setup (not hot path).
 * Worktree creation is a one-time initialization per session, so blocking is acceptable.
 */
export function detectDefaultBranch(repoPath: string): string {
  try {
    const ref = execFileSync('git', ['-C', repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: WORKTREE_GIT_TIMEOUT_MS,
    }).trim();
    // ref looks like "refs/remotes/origin/main" or "refs/remotes/origin/release/stable"
    const branch = ref.replace('refs/remotes/origin/', '');
    if (branch) return branch;
  } catch {
    // No origin or symbolic-ref not set — fall back
  }

  // Verify 'main' exists before using it as fallback
  try {
    execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', 'main'], {
      stdio: 'pipe',
      timeout: WORKTREE_GIT_TIMEOUT_MS,
    });
    return 'main';
  } catch {
    // 'main' doesn't exist — fall back to HEAD
  }

  return 'HEAD';
}

/** Worktrees live inside each repo at .claude/worktrees/<sessionId>. */
function worktreesDir(baseRepo: string): string {
  return join(baseRepo, '.claude', 'worktrees');
}

/**
 * Parse creation age from a worktree directory name (YYYY-MM-DD-XXXXXX format).
 * Returns age in milliseconds, or null if the name doesn't match the convention.
 */
export function parseWorktreeAge(entry: string): number | null {
  const match = entry.match(/^(\d{4})-(\d{2})-(\d{2})-[a-f0-9]{6}$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const created = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (isNaN(created.getTime())) return null;
  // Reject impossible dates that Date normalizes (e.g. Feb 31 → Mar 3)
  if (created.getUTCMonth() + 1 !== Number(month) || created.getUTCDate() !== Number(day)) {
    return null;
  }
  const age = Date.now() - created.getTime();
  if (age < 0) return null;
  return age;
}

export interface CreateWorktreeOptions {
  dir?: string;
  branch?: string;
  prefix?: '.claude' | '.cursor';
  /** Git ref to branch from. Defaults to the repo's default branch (detected dynamically, falls back to 'main'). */
  startPoint?: string;
}

export function createWorktree(
  sessionId: string,
  baseRepo: string,
  opts?: CreateWorktreeOptions,
): string {
  const prefix = opts?.prefix ?? '.claude';
  const dir = opts?.dir ?? join(baseRepo, prefix, 'worktrees');
  mkdirSync(dir, { recursive: true });

  const worktreePath = join(dir, sessionId);
  const branch = opts?.branch ?? `${WORKTREE_BRANCH_PREFIX}${sessionId}`;
  const startPoint = opts?.startPoint ?? detectDefaultBranch(baseRepo);

  // If the worktree path already exists (stale from a previous session),
  // check whether it's a valid worktree we can reuse or a stale directory
  // that needs to be cleaned up before we can create a fresh one.
  if (existsSync(worktreePath)) {
    try {
      execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-dir'], {
        stdio: 'pipe',
        timeout: WORKTREE_GIT_TIMEOUT_MS,
      });
      // Valid worktree — reuse it.
      log.info(`reusing existing worktree: ${worktreePath} (${branch})`);
      return worktreePath;
    } catch {
      // Stale directory — remove it and prune git's worktree list.
      log.info(`removing stale worktree path: ${worktreePath}`);
      rmSync(worktreePath, { recursive: true, force: true });
      try {
        execFileSync('git', ['-C', baseRepo, 'worktree', 'prune'], {
          stdio: 'pipe',
          timeout: WORKTREE_PRUNE_TIMEOUT_MS,
        });
      } catch {}
    }
  }

  try {
    execFileSync(
      'git',
      ['-C', baseRepo, 'worktree', 'add', '-b', branch, worktreePath, startPoint],
      { stdio: 'pipe', timeout: WORKTREE_GIT_TIMEOUT_MS },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('already exists')) {
      // Branch exists but no worktree — reset it to startPoint before attaching
      execFileSync('git', ['-C', baseRepo, 'branch', '-f', branch, startPoint], {
        stdio: 'pipe',
        timeout: WORKTREE_GIT_TIMEOUT_MS,
      });
      execFileSync('git', ['-C', baseRepo, 'worktree', 'add', worktreePath, branch], {
        stdio: 'pipe',
        timeout: WORKTREE_GIT_TIMEOUT_MS,
      });
    } else {
      throw err;
    }
  }

  log.info(`created: ${worktreePath} (${branch}) from ${startPoint}`);
  return worktreePath;
}

/**
 * Async version of createWorktree — does not block the event loop.
 * Used for on-demand secondary worktree creation in the permission handler.
 */
export async function createWorktreeAsync(
  sessionId: string,
  baseRepo: string,
  opts?: CreateWorktreeOptions,
): Promise<string> {
  const prefix = opts?.prefix ?? '.claude';
  const dir = opts?.dir ?? join(baseRepo, prefix, 'worktrees');
  await mkdir(dir, { recursive: true });

  const worktreePath = join(dir, sessionId);
  const branch = opts?.branch ?? `${WORKTREE_BRANCH_PREFIX}${sessionId}`;
  const startPoint = opts?.startPoint ?? detectDefaultBranch(baseRepo);

  if (existsSync(worktreePath)) {
    try {
      await execFileAsync('git', ['-C', worktreePath, 'rev-parse', '--git-dir'], {
        timeout: WORKTREE_GIT_TIMEOUT_MS,
      });
      log.info(`reusing existing worktree: ${worktreePath} (${branch})`);
      return worktreePath;
    } catch {
      log.info(`removing stale worktree path: ${worktreePath}`);
      rmSync(worktreePath, { recursive: true, force: true });
      try {
        await execFileAsync('git', ['-C', baseRepo, 'worktree', 'prune'], {
          timeout: WORKTREE_PRUNE_TIMEOUT_MS,
        });
      } catch {}
    }
  }

  try {
    await execFileAsync(
      'git',
      ['-C', baseRepo, 'worktree', 'add', '-b', branch, worktreePath, startPoint],
      { timeout: WORKTREE_GIT_TIMEOUT_MS },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('already exists')) {
      // Branch exists but no worktree — reset it to startPoint before attaching
      await execFileAsync('git', ['-C', baseRepo, 'branch', '-f', branch, startPoint], {
        timeout: WORKTREE_GIT_TIMEOUT_MS,
      });
      await execFileAsync('git', ['-C', baseRepo, 'worktree', 'add', worktreePath, branch], {
        timeout: WORKTREE_GIT_TIMEOUT_MS,
      });
    } else {
      throw err;
    }
  }

  log.info(`created: ${worktreePath} (${branch}) from ${startPoint}`);
  return worktreePath;
}

/**
 * Scan disk for existing worktrees matching a session ID across all configured repos.
 * Used on resume to rebuild session.worktreePaths after server restart.
 * Checks both .claude/worktrees/ and .cursor/worktrees/ prefixes.
 */
export function discoverSessionWorktrees(
  wtId: string,
  primaryRepo: string,
  secondaryRepos: Record<string, string>,
): Map<string, { path: string; wtId: string }> {
  const result = new Map<string, { path: string; wtId: string }>();
  const prefixes = ['.claude', '.cursor'] as const;

  const allRepos: Array<[string, string]> = [['primary', primaryRepo]];
  for (const [name, repoPath] of Object.entries(secondaryRepos)) {
    allRepos.push([name, repoPath]);
  }

  for (const [name, repoPath] of allRepos) {
    for (const prefix of prefixes) {
      const candidate = join(repoPath, prefix, 'worktrees', wtId);
      if (existsSync(candidate)) {
        result.set(name, { path: candidate, wtId });
        break;
      }
    }
  }

  return result;
}

/**
 * Create symlinks for runtime directories (e.g. .venv, node_modules) from the
 * source repo into a worktree. Opt-in escape hatch for CWD-relative tool
 * resolution. Symlinked dirs are shared mutable state across sessions.
 *
 * Idempotent: skips dirs that don't exist in the source, and handles
 * already-existing symlinks (e.g. on resume).
 */
export function symlinkRuntimeDirs(repoPath: string, worktreePath: string, dirs: string[]): void {
  for (const dir of dirs) {
    const source = join(repoPath, dir);
    const target = join(worktreePath, dir);

    if (!existsSync(source)) continue;

    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        const existing = readlinkSync(target);
        if (existing === source) continue;
        log.warn('replacing stale runtime symlink', { dir, existing, expected: source });
        unlinkSync(target);
      }
    } catch {
      // target doesn't exist — proceed to create
    }

    try {
      symlinkSync(source, target);
      log.info('runtime symlink created', { dir, source, target });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('EEXIST')) continue;
      log.warn('failed to create runtime symlink', { dir, source, target, error: message });
    }
  }
}

/**
 * Create worktrees for the primary repo and all configured secondary repos.
 * All worktrees share the same session ID and branch name.
 * Returns a map of repo name → { path, branch }.
 */
export function createSessionWorktrees(
  sessionId: string,
  primaryRepo: string,
  secondaryRepos: Record<string, string>,
  opts?: { prefix?: '.claude' | '.cursor' },
): Record<string, { path: string; branch: string }> {
  const branch = `${WORKTREE_BRANCH_PREFIX}${sessionId}`;
  const prefix = opts?.prefix ?? '.claude';
  const results: Record<string, { path: string; branch: string }> = {};

  const primaryPath = createWorktree(sessionId, primaryRepo, { branch, prefix });
  results.primary = { path: primaryPath, branch };

  for (const [name, repoPath] of Object.entries(secondaryRepos)) {
    try {
      const path = createWorktree(sessionId, repoPath, { branch, prefix });
      results[name] = { path, branch };
    } catch (err: unknown) {
      log.warn('secondary worktree creation failed', {
        repo: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/**
 * Remove a worktree directory. Branches are preserved — they persist for PRs
 * and are cleaned up separately by pruning logic.
 */
export function removeWorktree(sessionId: string, baseRepo: string): void {
  const worktreePath = join(worktreesDir(baseRepo), sessionId);

  try {
    execFileSync('git', ['-C', baseRepo, 'worktree', 'remove', '--force', worktreePath], {
      stdio: 'pipe',
      timeout: WORKTREE_REMOVE_TIMEOUT_MS,
    });
  } catch {
    if (existsSync(worktreePath)) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch (err: unknown) {
        log.warn('failed to force-remove worktree directory', {
          path: worktreePath,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
  }

  try {
    execFileSync('git', ['-C', baseRepo, 'worktree', 'prune'], {
      stdio: 'pipe',
      timeout: WORKTREE_PRUNE_TIMEOUT_MS,
    });
  } catch {
    // Non-fatal — prune is best-effort cleanup
  }

  log.info(`removed: ${worktreePath}`);
}

export function getWorktreePath(sessionId: string, baseRepo: string): string | null {
  const worktreePath = join(worktreesDir(baseRepo), sessionId);
  return existsSync(worktreePath) ? worktreePath : null;
}

/**
 * Check if a worktree has uncommitted changes (modified, staged, or untracked files).
 */
/**
 * Check if a worktree has uncommitted changes (modified, staged, or untracked files).
 * Returns the porcelain output if dirty, empty string if clean, or a sentinel
 * error message if git status itself fails (so we don't delete potentially dirty worktrees).
 */
export function hasUncommittedWork(worktreePath: string): string | null {
  try {
    const output = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: WORKTREE_GIT_TIMEOUT_MS,
    }).trim();
    return output || null;
  } catch (err: unknown) {
    // Treat git failure as dirty — better to skip than to delete potentially dirty work
    const message = err instanceof Error ? err.message : 'unknown';
    log.warn('git status failed on worktree, treating as dirty', {
      path: worktreePath,
      error: message,
    });
    return `[git status failed: ${message}]`;
  }
}

/**
 * Async version of hasUncommittedWork — does not block the event loop.
 * Used by SessionOverviewEmitter's background refresh loop.
 */
export async function hasUncommittedWorkAsync(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'status', '--porcelain'], {
      encoding: 'utf-8',
      timeout: WORKTREE_GIT_TIMEOUT_MS,
    });
    const output = stdout.trim();
    return output || null;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown';
    log.warn('git status failed on worktree (async), treating as dirty', {
      path: worktreePath,
      error: message,
    });
    return `[git status failed: ${message}]`;
  }
}

/**
 * Post a proposal to the mgmt inbox about a stale worktree with uncommitted work.
 */
function postDirtyWorktreeToInbox(
  sessionId: string,
  repoName: string,
  worktreePath: string,
  branch: string,
  dirtyFiles: string,
  inboxDir: string,
): void {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const filename = `${ts}_worktree_gc_${sessionId}.md`;
  const lines = dirtyFiles.split('\n');
  // git status --porcelain: XY format where X=staged, Y=unstaged
  const modified = lines.filter((l) => l.startsWith(' M')).length;
  const untracked = lines.filter((l) => l.startsWith('??')).length;
  const staged = lines.filter((l) => /^[ADMR]/.test(l)).length;

  const summary = [
    modified > 0 ? `${modified} modified` : '',
    staged > 0 ? `${staged} staged` : '',
    untracked > 0 ? `${untracked} untracked` : '',
  ]
    .filter(Boolean)
    .join(', ');

  const content = `---
agent: worktree_gc
timestamp: ${new Date().toISOString()}
status: pending
tags: [worktree, uncommitted-work, needs-rescue]
---

# Stale worktree has uncommitted work

**Session:** ${sessionId}
**Repo:** ${repoName}
**Branch:** ${branch}
**Path:** ${worktreePath}
**Files:** ${summary}

\`\`\`
${dirtyFiles}
\`\`\`

**Action:** This worktree is ${WORKTREE_STALE_HOURS / 24}+ days old and has uncommitted changes. Rescue the work (commit/stash) or approve cleanup.
`;

  try {
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, filename), content);
    log.info('posted dirty worktree to inbox', { sessionId, repo: repoName });
  } catch (err: unknown) {
    log.warn('failed to post dirty worktree to inbox', {
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/**
 * Clean up stale worktrees in the given repo's .claude/worktrees/ directory.
 * Worktrees with uncommitted work are skipped and flagged in the mgmt inbox.
 * Worktrees belonging to active sessions are never cleaned up.
 * @param inboxDir — path to the mgmt inbox directory for dirty worktree proposals.
 * @param activeSessionIds — wtIds of sessions currently in the registry (always skipped).
 */
export function cleanupStaleWorktrees(
  baseRepo: string,
  inboxDir?: string,
  activeSessionIds?: ReadonlySet<string>,
): void {
  const dir = worktreesDir(baseRepo);
  if (!existsSync(dir)) return;

  const now = Date.now();
  const cutoff = WORKTREE_STALE_HOURS * 60 * 60 * 1000;
  let cleaned = 0;
  let skipped = 0;
  let protected_ = 0;

  for (const entry of readdirSync(dir)) {
    if (activeSessionIds?.has(entry)) {
      protected_++;
      continue;
    }

    const fullPath = join(dir, entry);
    try {
      // Prefer name-based age (immune to mtime being refreshed by git operations),
      // but also require mtime to be past cutoff as a safety net — a recently-touched
      // worktree (e.g. active session) should never be cleaned up regardless of name age.
      const nameAge = parseWorktreeAge(entry);
      const mtimeAge = now - statSync(fullPath).mtimeMs;
      const isStale = nameAge !== null ? nameAge > cutoff && mtimeAge > cutoff : mtimeAge > cutoff;

      if (isStale) {
        const dirty = hasUncommittedWork(fullPath);
        if (dirty && inboxDir) {
          // Only post once per session — check if an inbox item already exists
          const alreadyNotified =
            existsSync(inboxDir) &&
            readdirSync(inboxDir).some((f) => f.endsWith(`_worktree_gc_${entry}.md`));
          if (!alreadyNotified) {
            const branch = `${WORKTREE_BRANCH_PREFIX}${entry}`;
            const repoName = basename(baseRepo);
            postDirtyWorktreeToInbox(entry, repoName, fullPath, branch, dirty, inboxDir);
          }
          skipped++;
          log.info('skipped stale worktree with uncommitted work', {
            repo: baseRepo,
            session: entry,
          });
          continue;
        }
        removeWorktree(entry, baseRepo);
        cleaned++;
      }
    } catch (err: unknown) {
      log.warn('failed to check worktree entry during cleanup', {
        repo: baseRepo,
        entry,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  try {
    execFileSync('git', ['-C', baseRepo, 'worktree', 'prune'], {
      stdio: 'pipe',
      timeout: WORKTREE_PRUNE_TIMEOUT_MS,
    });
  } catch {
    // Non-fatal
  }

  if (cleaned > 0 || skipped > 0 || protected_ > 0) {
    log.info(
      `worktree cleanup: ${cleaned} removed, ${skipped} skipped (dirty), ${protected_} active`,
      { repo: baseRepo },
    );
  }
}

/**
 * Count worktrees in a repo's .claude/worktrees/ directory.
 * Used for inventory logging at startup and periodic health checks.
 */
export function countWorktrees(baseRepo: string): number {
  const dir = worktreesDir(baseRepo);
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((e) => {
      try {
        return statSync(join(dir, e)).isDirectory();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

/** Also check legacy -sessions/ sibling dir for backward compat. */
function legacySessionsDir(baseRepo: string): string {
  return `${baseRepo}-sessions`;
}

export function listWorktrees(
  baseRepo: string,
): Array<{ name: string; path: string; age: string }> {
  const results: Array<{ name: string; path: string; age: string }> = [];
  const now = Date.now();

  // Check new location (.claude/worktrees/)
  const dir = worktreesDir(baseRepo);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      try {
        const nameAge = parseWorktreeAge(entry);
        const ageMs = nameAge ?? now - statSync(fullPath).mtimeMs;
        const hours = Math.floor(ageMs / 3_600_000);
        results.push({ name: entry, path: fullPath, age: hours < 1 ? '<1h' : `${hours}h` });
      } catch {
        results.push({ name: entry, path: fullPath, age: 'unknown' });
      }
    }
  }

  // Check legacy location (<repo>-sessions/)
  const legacyDir = legacySessionsDir(baseRepo);
  if (existsSync(legacyDir)) {
    for (const entry of readdirSync(legacyDir)) {
      if (!entry.startsWith('session-')) continue;
      const fullPath = join(legacyDir, entry);
      try {
        const stat = statSync(fullPath);
        const hours = Math.floor((now - stat.mtimeMs) / 3_600_000);
        results.push({
          name: `${entry} (legacy)`,
          path: fullPath,
          age: hours < 1 ? '<1h' : `${hours}h`,
        });
      } catch {
        results.push({ name: `${entry} (legacy)`, path: fullPath, age: 'unknown' });
      }
    }
  }

  return results;
}

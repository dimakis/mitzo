/* eslint no-empty: ["error", { allowEmptyCatch: true }] */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync, rmSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import {
  WORKTREE_BRANCH_PREFIX,
  WORKTREE_STALE_HOURS,
  WORKTREE_GIT_TIMEOUT_MS,
  WORKTREE_REMOVE_TIMEOUT_MS,
  WORKTREE_PRUNE_TIMEOUT_MS,
} from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('worktree');

/** Worktrees live inside each repo at .claude/worktrees/<sessionId>. */
function worktreesDir(baseRepo: string): string {
  return join(baseRepo, '.claude', 'worktrees');
}

export function createWorktree(sessionId: string, baseRepo: string): string {
  const dir = worktreesDir(baseRepo);
  mkdirSync(dir, { recursive: true });

  const worktreePath = join(dir, sessionId);
  const branch = `${WORKTREE_BRANCH_PREFIX}${sessionId}`;

  try {
    execFileSync('git', ['-C', baseRepo, 'worktree', 'add', '-b', branch, worktreePath], {
      stdio: 'pipe',
      timeout: WORKTREE_GIT_TIMEOUT_MS,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Branch may already exist from a previous session with the same slug
    if (message.includes('already exists')) {
      execFileSync('git', ['-C', baseRepo, 'worktree', 'add', worktreePath, branch], {
        stdio: 'pipe',
        timeout: WORKTREE_GIT_TIMEOUT_MS,
      });
    } else {
      throw err;
    }
  }

  log.info(`created: ${worktreePath} (${branch})`);
  return worktreePath;
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
function hasUncommittedWork(worktreePath: string): string | null {
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
 * @param inboxDir — path to the mgmt inbox directory for dirty worktree proposals.
 */
export function cleanupStaleWorktrees(baseRepo: string, inboxDir?: string): void {
  const dir = worktreesDir(baseRepo);
  if (!existsSync(dir)) return;

  const now = Date.now();
  const cutoff = WORKTREE_STALE_HOURS * 60 * 60 * 1000;
  let cleaned = 0;
  let skipped = 0;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (now - stat.mtimeMs > cutoff) {
        const dirty = hasUncommittedWork(fullPath);
        if (dirty && inboxDir) {
          const branch = `${WORKTREE_BRANCH_PREFIX}${entry}`;
          const repoName = basename(baseRepo);
          postDirtyWorktreeToInbox(entry, repoName, fullPath, branch, dirty, inboxDir);
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
      log.warn('failed to stat worktree entry during cleanup', {
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

  if (cleaned > 0 || skipped > 0) {
    log.info(`worktree cleanup: ${cleaned} removed, ${skipped} skipped (dirty)`, {
      repo: baseRepo,
    });
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
        const stat = statSync(fullPath);
        const hours = Math.floor((now - stat.mtimeMs) / 3_600_000);
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

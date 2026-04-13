/* eslint no-empty: ["error", { allowEmptyCatch: true }] */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
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
 * Clean up stale worktrees in the given repo's .claude/worktrees/ directory.
 * Callers iterate repos individually — no multi-repo parameter needed.
 */
export function cleanupStaleWorktrees(baseRepo: string): void {
  const dir = worktreesDir(baseRepo);
  if (!existsSync(dir)) return;

  const now = Date.now();
  const cutoff = WORKTREE_STALE_HOURS * 60 * 60 * 1000;
  let cleaned = 0;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (now - stat.mtimeMs > cutoff) {
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

  if (cleaned > 0) {
    log.info(`cleaned up ${cleaned} stale worktree(s) in ${baseRepo}`);
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

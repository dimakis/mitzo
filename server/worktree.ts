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
  WORKTREE_BRANCH_DELETE_TIMEOUT_MS,
} from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('worktree');

function sessionsDir(baseRepo: string): string {
  return `${baseRepo}-sessions`;
}

export function createWorktree(sessionId: string, baseRepo: string): string {
  const dir = sessionsDir(baseRepo);
  mkdirSync(dir, { recursive: true });

  const worktreePath = join(dir, `session-${sessionId}`);
  const branch = `${WORKTREE_BRANCH_PREFIX}${sessionId}`;

  execFileSync('git', ['-C', baseRepo, 'worktree', 'add', '-b', branch, worktreePath], {
    stdio: 'pipe',
    timeout: WORKTREE_GIT_TIMEOUT_MS,
  });

  log.info(`created: ${worktreePath} (${branch})`);
  return worktreePath;
}

export function removeWorktree(sessionId: string, baseRepo: string): void {
  const worktreePath = join(sessionsDir(baseRepo), `session-${sessionId}`);
  const branch = `${WORKTREE_BRANCH_PREFIX}${sessionId}`;

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
    execFileSync('git', ['-C', baseRepo, 'branch', '-D', branch], {
      stdio: 'pipe',
      timeout: WORKTREE_BRANCH_DELETE_TIMEOUT_MS,
    });
  } catch {
    // Branch may already be deleted or never created
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
  const worktreePath = join(sessionsDir(baseRepo), `session-${sessionId}`);
  return existsSync(worktreePath) ? worktreePath : null;
}

export function cleanupStaleWorktrees(baseRepo: string): void {
  const dir = sessionsDir(baseRepo);
  if (!existsSync(dir)) return;

  const now = Date.now();
  const cutoff = WORKTREE_STALE_HOURS * 60 * 60 * 1000;
  let cleaned = 0;

  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith('session-')) continue;

    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (now - stat.mtimeMs > cutoff) {
        const sessionId = entry.replace('session-', '');
        removeWorktree(sessionId, baseRepo);
        cleaned++;
      }
    } catch (err: unknown) {
      log.warn('failed to stat worktree entry during cleanup', {
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
    // Non-fatal — prune is best-effort cleanup
  }

  if (cleaned > 0) {
    log.info(`cleaned up ${cleaned} stale worktree(s)`);
  }
}

export function listWorktrees(
  baseRepo: string,
): Array<{ name: string; path: string; age: string }> {
  const dir = sessionsDir(baseRepo);
  if (!existsSync(dir)) return [];

  const now = Date.now();
  return readdirSync(dir)
    .filter((e) => e.startsWith('session-'))
    .map((entry) => {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        const hours = Math.floor((now - stat.mtimeMs) / 3_600_000);
        return { name: entry, path: fullPath, age: hours < 1 ? '<1h' : `${hours}h` };
      } catch {
        return { name: entry, path: fullPath, age: 'unknown' }; // Stat failed — show with unknown age
      }
    });
}

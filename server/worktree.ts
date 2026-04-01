/* eslint no-empty: ["error", { allowEmptyCatch: true }] */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const BRANCH_PREFIX = 'session/';
const STALE_HOURS = 168; // 7 days

function sessionsDir(baseRepo: string): string {
  return `${baseRepo}-sessions`;
}

export function createWorktree(sessionId: string, baseRepo: string): string {
  const dir = sessionsDir(baseRepo);
  mkdirSync(dir, { recursive: true });

  const worktreePath = join(dir, `session-${sessionId}`);
  const branch = `${BRANCH_PREFIX}${sessionId}`;

  execFileSync('git', ['-C', baseRepo, 'worktree', 'add', '-b', branch, worktreePath], {
    stdio: 'pipe',
    timeout: 30_000,
  });

  console.log(`[worktree] created: ${worktreePath} (${branch})`);
  return worktreePath;
}

export function removeWorktree(sessionId: string, baseRepo: string): void {
  const worktreePath = join(sessionsDir(baseRepo), `session-${sessionId}`);
  const branch = `${BRANCH_PREFIX}${sessionId}`;

  try {
    execFileSync('git', ['-C', baseRepo, 'worktree', 'remove', '--force', worktreePath], {
      stdio: 'pipe',
      timeout: 15_000,
    });
  } catch {
    if (existsSync(worktreePath)) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {}
    }
  }

  try {
    execFileSync('git', ['-C', baseRepo, 'branch', '-D', branch], {
      stdio: 'pipe',
      timeout: 5_000,
    });
  } catch {}

  try {
    execFileSync('git', ['-C', baseRepo, 'worktree', 'prune'], {
      stdio: 'pipe',
      timeout: 5_000,
    });
  } catch {}

  console.log(`[worktree] removed: ${worktreePath}`);
}

export function getWorktreePath(sessionId: string, baseRepo: string): string | null {
  const worktreePath = join(sessionsDir(baseRepo), `session-${sessionId}`);
  return existsSync(worktreePath) ? worktreePath : null;
}

export function cleanupStaleWorktrees(baseRepo: string): void {
  const dir = sessionsDir(baseRepo);
  if (!existsSync(dir)) return;

  const now = Date.now();
  const cutoff = STALE_HOURS * 60 * 60 * 1000;
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
    } catch {}
  }

  try {
    execFileSync('git', ['-C', baseRepo, 'worktree', 'prune'], {
      stdio: 'pipe',
      timeout: 5_000,
    });
  } catch {}

  if (cleaned > 0) {
    console.log(`[worktree] cleaned up ${cleaned} stale worktree(s)`);
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
        return { name: entry, path: fullPath, age: 'unknown' };
      }
    });
}

export function getWorktreeForSession(sessionId: string, baseRepo: string): string | null {
  const claudeProjects = join(homedir(), '.claude', 'projects');
  const sessionsPrefix = baseRepo.replace(/\//g, '-') + '-sessions-session-';

  try {
    for (const entry of readdirSync(claudeProjects)) {
      if (!entry.startsWith(sessionsPrefix)) continue;
      const projectDir = join(claudeProjects, entry);
      if (existsSync(join(projectDir, `${sessionId}.jsonl`))) {
        const originalPath = '/' + entry.slice(1).replace(/-/g, '/');
        if (existsSync(originalPath)) return originalPath;
      }
    }
  } catch {}

  return null;
}

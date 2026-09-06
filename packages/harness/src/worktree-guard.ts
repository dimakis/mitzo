import { existsSync } from 'node:fs';
import type { ManagedSession } from './session-registry.js';
import { createLogger } from './logger.js';

const log = createLogger('worktree-guard');

const WRITE_TOOLS = new Set(['Write', 'Edit', 'StrReplace', 'EditNotebook', 'MultiEdit']);
const SHELL_TOOLS = new Set(['Bash', 'Shell']);
const PATH_FIELDS = ['file_path', 'path', 'target_notebook'];

const stats = { allowed: 0, denied: 0 };

export function getWorktreeGuardStats() {
  return { ...stats };
}

export function resetWorktreeGuardStats() {
  stats.allowed = 0;
  stats.denied = 0;
}

/**
 * Callback for on-demand worktree creation. Given the absolute path the agent
 * tried to write to, creates a worktree for the matching repo and returns its
 * name + path. Returns null if creation failed or the path doesn't match any
 * configured repo.
 */
export type OnDemandCreateFn = (
  absolutePath: string,
) => Promise<{ repoName: string; worktreePath: string } | null>;

export interface CheckWorktreePolicyOptions {
  onDemandCreate?: OnDemandCreateFn;
  /** Override fs.existsSync for testing. Defaults to node:fs existsSync. */
  pathExists?: (p: string) => boolean;
}

/**
 * Extract absolute paths from a shell command string. Heuristic — catches
 * explicit absolute paths but can't catch every indirect construction.
 */
function extractAbsolutePaths(command: string): string[] {
  const results: string[] = [];
  const quotedRe = /["'](\/[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = quotedRe.exec(command)) !== null) {
    results.push(m[1]);
  }
  const unquotedRe = /(?:^|\s|=)(\/[\w/.@~-]+)/g;
  while ((m = unquotedRe.exec(command)) !== null) {
    results.push(m[1]);
  }
  return results;
}

function findAllowedWorktree(
  absolutePath: string,
  worktreePaths: Map<string, { path: string; wtId: string }>,
  pathExists: (p: string) => boolean = existsSync,
): { repoName: string; worktreePath: string } | null {
  for (const [name, { path }] of worktreePaths) {
    if (absolutePath.startsWith(path + '/') || absolutePath === path) {
      // Worktree was cleaned up (stale GC or manual removal) — evict the
      // stale entry so on-demand creation can recreate it.
      if (!pathExists(path)) {
        log.info('evicting stale worktree entry', { repo: name, path });
        worktreePaths.delete(name);
        continue;
      }
      return { repoName: name, worktreePath: path };
    }
  }
  return null;
}

/**
 * Find the worktree path that should be used for a given out-of-bounds path.
 * Maps /repo-root/some/file to /repo-root/.claude/worktrees/ID/some/file.
 */
function suggestWorktreePath(
  absolutePath: string,
  worktreePaths: Map<string, { path: string; wtId: string }>,
): string | null {
  for (const [, { path: wtPath }] of worktreePaths) {
    const worktreeMarker = wtPath.match(/^(.+?)\/(\.claude|\.cursor)\/worktrees\/.+$/);
    if (!worktreeMarker) continue;

    const repoRoot = worktreeMarker[1];
    if (absolutePath.startsWith(repoRoot + '/') || absolutePath === repoRoot) {
      const relativePath = absolutePath.slice(repoRoot.length);
      return wtPath + relativePath;
    }
  }
  return null;
}

function denyMessage(prefix: string, attemptedPath: string, suggestion: string | null): string {
  return suggestion
    ? `${prefix} ${attemptedPath} is outside session worktrees. Use ${suggestion} instead.`
    : `${prefix} ${attemptedPath} is outside session worktrees. Check $MITZO_REPO_* env vars for correct paths.`;
}

/**
 * Check if a tool invocation violates worktree isolation.
 * Returns null if allowed, or a deny message with the correct path.
 *
 * When `onDemandCreate` is provided and the path maps to a configured repo
 * without a worktree, creation is attempted. On success the worktree is added
 * to the session and a redirect is returned. On failure a hard deny is returned
 * (no redirect) to prevent retry loops.
 */
export async function checkWorktreePolicy(
  session: ManagedSession,
  toolName: string,
  toolInput: Record<string, unknown>,
  opts?: CheckWorktreePolicyOptions,
): Promise<string | null> {
  if (session.worktreePaths.size === 0) return null;
  const checkPath = opts?.pathExists ?? existsSync;

  if (WRITE_TOOLS.has(toolName)) {
    let checkedAnyPath = false;
    for (const field of PATH_FIELDS) {
      const filePath = toolInput[field];
      if (typeof filePath !== 'string' || !filePath.startsWith('/')) continue;
      checkedAnyPath = true;

      const allowed = findAllowedWorktree(filePath, session.worktreePaths, checkPath);
      if (allowed) continue;

      // Try on-demand creation if a callback is provided
      if (opts?.onDemandCreate) {
        const created = await opts.onDemandCreate(filePath);
        if (created) {
          session.worktreePaths.set(created.repoName, {
            path: created.worktreePath,
            wtId: session.wtId ?? '',
          });
          const suggestion = suggestWorktreePath(filePath, session.worktreePaths);
          stats.denied++;
          log.info('on-demand worktree created, redirecting', {
            toolName,
            repo: created.repoName,
            sessionId: session.sessionId,
          });
          return denyMessage('Path', filePath, suggestion);
        }
      }

      const suggestion = suggestWorktreePath(filePath, session.worktreePaths);
      stats.denied++;
      log.warn('worktree policy denied', {
        toolName,
        attemptedPath: filePath,
        suggestedPath: suggestion,
        sessionId: session.sessionId,
      });
      return denyMessage('Path', filePath, suggestion);
    }
    if (checkedAnyPath) {
      stats.allowed++;
      log.debug('worktree policy allowed', { toolName, sessionId: session.sessionId });
    }
    return null;
  }

  if (SHELL_TOOLS.has(toolName)) {
    const command = toolInput.command;
    if (typeof command !== 'string') return null;

    const paths = extractAbsolutePaths(command);
    for (const p of paths) {
      if (findAllowedWorktree(p, session.worktreePaths, checkPath)) continue;

      if (opts?.onDemandCreate) {
        const created = await opts.onDemandCreate(p);
        if (created) {
          session.worktreePaths.set(created.repoName, {
            path: created.worktreePath,
            wtId: session.wtId ?? '',
          });
          const suggestion = suggestWorktreePath(p, session.worktreePaths);
          stats.denied++;
          log.info('on-demand worktree created, redirecting', {
            toolName,
            repo: created.repoName,
            sessionId: session.sessionId,
          });
          return denyMessage('Shell command references', p, suggestion);
        }
      }

      const suggestion = suggestWorktreePath(p, session.worktreePaths);
      stats.denied++;
      log.warn('worktree policy denied', {
        toolName,
        attemptedPath: p,
        suggestedPath: suggestion,
        sessionId: session.sessionId,
      });
      return denyMessage('Shell command references', p, suggestion);
    }
    stats.allowed++;
    log.debug('worktree policy allowed', { toolName, sessionId: session.sessionId });
  }

  return null;
}

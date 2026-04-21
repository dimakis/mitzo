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
 * Extract absolute paths from a shell command string. Heuristic — catches
 * explicit absolute paths but can't catch every indirect construction.
 */
function extractAbsolutePaths(command: string): string[] {
  const results: string[] = [];
  // Match quoted absolute paths (handles spaces)
  const quotedRe = /["'](\/[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = quotedRe.exec(command)) !== null) {
    results.push(m[1]);
  }
  // Match unquoted absolute paths (supports tildes and broader char set)
  const unquotedRe = /(?:^|\s|=)(\/[\w/.@~-]+)/g;
  while ((m = unquotedRe.exec(command)) !== null) {
    results.push(m[1]);
  }
  return results;
}

function findAllowedWorktree(
  absolutePath: string,
  worktreePaths: Map<string, { path: string; wtId: string }>,
): { repoName: string; worktreePath: string } | null {
  for (const [name, { path }] of worktreePaths) {
    if (absolutePath.startsWith(path + '/') || absolutePath === path) {
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
    // worktree path format: /repo-root/.claude/worktrees/<id>
    // extract repo root: everything before /.claude/worktrees/ or /.cursor/worktrees/
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

/**
 * Check if a tool invocation violates worktree isolation.
 * Returns null if allowed, or a deny message with the correct path.
 */
export function checkWorktreePolicy(
  session: ManagedSession,
  toolName: string,
  toolInput: Record<string, unknown>,
): string | null {
  if (session.worktreePaths.size === 0) return null;

  if (WRITE_TOOLS.has(toolName)) {
    let checkedAnyPath = false;
    for (const field of PATH_FIELDS) {
      const filePath = toolInput[field];
      if (typeof filePath !== 'string' || !filePath.startsWith('/')) continue;
      checkedAnyPath = true;

      const allowed = findAllowedWorktree(filePath, session.worktreePaths);
      if (allowed) continue;

      const suggestion = suggestWorktreePath(filePath, session.worktreePaths);
      const message = suggestion
        ? `Path ${filePath} is outside session worktrees. Use ${suggestion} instead.`
        : `Path ${filePath} is outside session worktrees. Check $MITZO_REPO_* env vars for correct paths.`;
      stats.denied++;
      log.warn('worktree policy denied', {
        toolName,
        attemptedPath: filePath,
        suggestedPath: suggestion,
        sessionId: session.sessionId,
      });
      return message;
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
      if (findAllowedWorktree(p, session.worktreePaths)) continue;

      const suggestion = suggestWorktreePath(p, session.worktreePaths);
      const message = suggestion
        ? `Shell command references ${p} which is outside session worktrees. Use ${suggestion} instead.`
        : `Shell command references ${p} which is outside session worktrees. Check $MITZO_REPO_* env vars for correct paths.`;
      stats.denied++;
      log.warn('worktree policy denied', {
        toolName,
        attemptedPath: p,
        suggestedPath: suggestion,
        sessionId: session.sessionId,
      });
      return message;
    }
    stats.allowed++;
    log.debug('worktree policy allowed', { toolName, sessionId: session.sessionId });
  }

  return null;
}

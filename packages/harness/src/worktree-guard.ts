import type { ManagedSession } from './session-registry.js';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('worktree-guard');

const WRITE_TOOLS = new Set([
  'Write',
  'Edit',
  'StrReplace',
  'EditNotebook',
  'NotebookEdit',
  'MultiEdit',
]);
const SHELL_TOOLS = new Set(['Bash', 'Shell']);
const PATH_FIELDS = ['file_path', 'path', 'target_notebook', 'notebook_path'];
const TRUSTED_ABSOLUTE_EXECUTABLES = new Set([
  '/opt/homebrew/bin/gws',
  '/usr/bin/git',
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  '/usr/bin/gh',
]);
/** Standard streams are not workspace paths (`> /dev/null`, `tee /dev/stderr`). */
const STANDARD_DEVICE_PATHS = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr']);

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
  signal?: AbortSignal,
) => Promise<{ repoName: string; worktreePath: string } | null>;

/**
 * Filesystem facts used to decide whether this process could create a shell
 * path at all. Injected by tests; defaults to the real filesystem.
 */
export interface PathCreationProbe {
  /** Whether an entry exists without following a final symlink (lstat). */
  exists(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  /** Whether this process may write the directory entry (access W_OK). */
  isWritable(path: string): Promise<boolean>;
}

function hasErrorCode(error: unknown, codes: readonly string[]): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && codes.includes(code);
}

export const nodePathCreationProbe: PathCreationProbe = {
  async exists(path) {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (hasErrorCode(error, ['ENOENT', 'ENOTDIR'])) return false;
      throw error;
    }
  },
  realpath: (path) => realpath(path),
  async isWritable(path) {
    try {
      await access(path, fsConstants.W_OK);
      return true;
    } catch (error) {
      if (hasErrorCode(error, ['EACCES', 'EPERM', 'EROFS'])) return false;
      throw error;
    }
  },
};

export interface CheckWorktreePolicyOptions {
  onDemandCreate?: OnDemandCreateFn;
  signal?: AbortSignal;
  /** Replaces the generic guidance when no session worktree maps the path. */
  outOfRootHint?: string;
  /** Defaults to {@link nodePathCreationProbe}. */
  pathProbe?: PathCreationProbe;
}

interface ShellPathReference {
  path: string;
  /**
   * The shell would use exactly this text as the path: no expansion,
   * concatenation or parent segments can turn it into a different one.
   */
  literal: boolean;
}

/** Characters that let the shell expand or rewrite the surrounding word. */
const SHELL_EXPANSION_CHARS = /[$`\\*?[{~]/;
/** Characters that end the path within its word (shell operators and common code punctuation). */
const PATH_TERMINATOR = /^(?:$|[\s;|&)<>,\]}])/;
/** Commands that write on behalf of another, possibly privileged, user. */
const DELEGATED_WRITER = /(?:^|[^\w-])(?:sudo|doas|pkexec|su|docker|podman|nerdctl)(?:[^\w-]|$)/;

function isLiteralReference(command: string, start: number, end: number, path: string): boolean {
  if (SHELL_EXPANSION_CHARS.test(path) || path.split('/').includes('..')) return false;
  const wordStart = command.slice(0, start).search(/\S*$/);
  const prefix = command.slice(wordStart, start);
  const suffix = command.slice(end).match(/^\S*/)![0];
  return (
    !SHELL_EXPANSION_CHARS.test(prefix) &&
    !SHELL_EXPANSION_CHARS.test(suffix) &&
    PATH_TERMINATOR.test(suffix)
  );
}

/**
 * Extract absolute paths from a shell command string. Heuristic — catches
 * explicit absolute paths but can't catch every indirect construction.
 */
function extractAbsolutePaths(command: string): ShellPathReference[] {
  const results: ShellPathReference[] = [];
  const quotedRe = /["'](\/[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = quotedRe.exec(command)) !== null) {
    const end = m.index + m[0].length;
    results.push({ path: m[1], literal: isLiteralReference(command, m.index, end, m[1]) });
  }
  const unquotedRe = /(?:^|\s|=)(\/[\w/.@~-]+)/g;
  while ((m = unquotedRe.exec(command)) !== null) {
    const end = m.index + m[0].length;
    const start = end - m[1].length;
    results.push({ path: m[1], literal: isLiteralReference(command, start, end, m[1]) });
  }
  const executableMatch = command
    .trimStart()
    .match(/^(?:["'](\/[^"']+)["']|(\/[\w/.@~-]+))(?:\s|$)/);
  const executablePath = executableMatch?.[1] ?? executableMatch?.[2];
  if (executablePath && TRUSTED_ABSOLUTE_EXECUTABLES.has(executablePath)) {
    const executableIndex = results.findIndex(({ path }) => path === executablePath);
    if (executableIndex >= 0) results.splice(executableIndex, 1);
  }
  return results.filter(({ path }) => !STANDARD_DEVICE_PATHS.has(path));
}

/**
 * True only when the path does not exist and its deepest existing ancestor
 * (symlinks resolved) is not writable by this process, so nothing this
 * unprivileged process runs can create it. Any doubt or probe failure
 * returns false so the caller keeps refusing.
 */
async function isUncreatableByThisProcess(
  path: string,
  probe: PathCreationProbe,
): Promise<boolean> {
  try {
    if (await probe.exists(path)) return false;
    let ancestor = path;
    do {
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    } while (!(await probe.exists(ancestor)));
    return !(await probe.isWritable(await probe.realpath(ancestor)));
  } catch {
    return false;
  }
}

function findAllowedWorktree(
  absolutePath: string,
  worktreePaths: Map<string, { path: string; wtId: string }>,
): { repoName: string; worktreePath: string } | null {
  absolutePath = resolve(absolutePath);
  for (const [name, { path }] of worktreePaths) {
    const root = resolve(path);
    if (absolutePath.startsWith(root + '/') || absolutePath === root) {
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

function denyMessage(
  prefix: string,
  attemptedPath: string,
  suggestion: string | null,
  outOfRootHint?: string,
): string {
  return suggestion
    ? `${prefix} ${attemptedPath} is outside session worktrees. Use ${suggestion} instead.`
    : `${prefix} ${attemptedPath} is outside session worktrees. ${outOfRootHint ?? 'Check $MITZO_REPO_* env vars for correct paths.'}`;
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
  opts?.signal?.throwIfAborted();
  if (session.worktreePaths.size === 0) return null;

  if (WRITE_TOOLS.has(toolName)) {
    let checkedAnyPath = false;
    for (const field of PATH_FIELDS) {
      const requestedPath = toolInput[field];
      if (typeof requestedPath !== 'string' || (!isAbsolute(requestedPath) && !session.cwd))
        continue;
      const filePath = resolve(session.cwd ?? '/', requestedPath);
      checkedAnyPath = true;

      const allowed = findAllowedWorktree(filePath, session.worktreePaths);
      if (allowed) continue;

      // Try on-demand creation if a callback is provided
      if (opts?.onDemandCreate) {
        const created = await (opts.signal
          ? opts.onDemandCreate(filePath, opts.signal)
          : opts.onDemandCreate(filePath));
        opts.signal?.throwIfAborted();
        if (created && !session.worktreePaths.has(created.repoName)) {
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
      return denyMessage('Path', filePath, suggestion, opts?.outOfRootHint);
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

    const references = extractAbsolutePaths(command);
    const probe = opts?.pathProbe ?? nodePathCreationProbe;
    const delegatesWrites = DELEGATED_WRITER.test(command);
    for (const { path: p, literal } of references) {
      if (findAllowedWorktree(p, session.worktreePaths)) continue;
      // Text such as an HTTP API path in a script cannot name a creatable
      // location when its nearest existing ancestor is unwritable to us.
      if (literal && !delegatesWrites && (await isUncreatableByThisProcess(p, probe))) {
        opts?.signal?.throwIfAborted();
        continue;
      }

      if (opts?.onDemandCreate) {
        const created = await (opts.signal
          ? opts.onDemandCreate(p, opts.signal)
          : opts.onDemandCreate(p));
        opts.signal?.throwIfAborted();
        if (created && !session.worktreePaths.has(created.repoName)) {
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
      return denyMessage('Shell command references', p, suggestion, opts?.outOfRootHint);
    }
    stats.allowed++;
    log.debug('worktree policy allowed', { toolName, sessionId: session.sessionId });
  }

  return null;
}

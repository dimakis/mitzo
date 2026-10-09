import { execFile } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { RequestHandler } from 'express';
import { GIT_BRANCH_TIMEOUT_MS } from './constants.js';
import { parseWorktreeAge } from './worktree.js';

const execFileAsync = promisify(execFile);
const BRANCH_ARGS = ['rev-parse', '--abbrev-ref', 'HEAD'];
const WORKTREE_ARGS = ['worktree', 'list', '--porcelain', '-z'];

interface BrowserWorktree {
  name: string;
  path: string;
  branch: string;
  age: string;
  repo: string;
}

interface DiscoveryOptions {
  runGit?: (repoPath: string, args: string[]) => Promise<string>;
  now?: () => number;
  cacheTtlMs?: number;
  concurrency?: number;
}

/** Decode Git's NUL format, including paths containing whitespace or newlines. */
function browserWorktrees(output: string, parents: string[], repo: string): BrowserWorktree[] {
  return output.split('\0\0').flatMap((record) => {
    const fields = record.split('\0');
    const path = fields.find((field) => field.startsWith('worktree '))?.slice(9);
    if (
      !path ||
      !parents.some((parent) => resolve(path).startsWith(parent)) ||
      fields.some((field) => field === 'bare' || field.startsWith('prunable'))
    )
      return [];
    const branch =
      fields
        .find((field) => field.startsWith('branch '))
        ?.slice(7)
        .replace(/^refs\/heads\//, '') || 'HEAD';
    const legacy = resolve(path).startsWith(parents[2]);
    const entryName = basename(path);
    if (legacy && !entryName.startsWith('session-')) return [];
    const name = legacy ? `${entryName} (legacy)` : entryName;
    const age = parseWorktreeAge(entryName);
    const hours = age === null ? null : Math.floor(age / 3_600_000);
    return [
      {
        name,
        path,
        branch,
        age: hours === null ? 'unknown' : hours < 1 ? '<1h' : `${hours}h`,
        repo,
      },
    ];
  });
}

/** A small shared process budget and cache: no directory walks or per-worktree Git calls. */
export function createGitInfoDiscovery(options: DiscoveryOptions = {}) {
  const now = options.now ?? Date.now;
  const ttl = options.cacheTtlMs ?? 30_000;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const runGit =
    options.runGit ??
    (async (cwd, args) => {
      const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', ...args], {
        cwd,
        encoding: 'utf8',
        timeout: GIT_BRANCH_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      return stdout;
    });
  const cache = new Map<string, { promise: Promise<string>; expires: number }>();
  const waiting: Array<() => void> = [];
  let active = 0;

  async function boundedGit(repoPath: string, args: string[]): Promise<string> {
    if (active >= concurrency) await new Promise<void>((ready) => waiting.push(ready));
    else active++;
    try {
      return await runGit(repoPath, args);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  function cachedGit(repoPath: string, args: string[]): Promise<string> {
    const key = JSON.stringify([resolve(repoPath), args]);
    const existing = cache.get(key);
    if (existing && existing.expires > now()) return existing.promise;
    const entry = { promise: boundedGit(repoPath, args), expires: Number.POSITIVE_INFINITY };
    cache.set(key, entry);
    // Bound retained results even if host configuration changes repeatedly.
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    void entry.promise.then(
      () => {
        entry.expires = now() + ttl;
      },
      () => {
        if (cache.get(key) === entry) cache.delete(key);
      },
    );
    return entry.promise;
  }

  async function getInfo(repoPath: string, repos: Record<string, string>, loadWorktrees = false) {
    const branchPromise = cachedGit(repoPath, BRANCH_ARGS)
      .then((output) => output.trim() || 'unknown')
      .catch(() => 'unknown');
    const worktreesPromise = loadWorktrees
      ? Promise.all(
          [['primary', repoPath], ...Object.entries(repos)].map(async ([name, path]) => {
            try {
              const parents = [
                join(path, '.claude', 'worktrees'),
                join(path, '.cursor', 'worktrees'),
                `${path}-sessions`,
              ];
              const [output, allowedParents] = await Promise.all([
                cachedGit(path, WORKTREE_ARGS),
                Promise.all(
                  parents.map(
                    async (parent) => (await realpath(parent).catch(() => resolve(parent))) + '/',
                  ),
                ),
              ]);
              return { worktrees: browserWorktrees(output, allowedParents, name), loaded: true };
            } catch {
              return { worktrees: [], loaded: false };
            }
          }),
        )
      : Promise.resolve([]);
    const [branch, results] = await Promise.all([branchPromise, worktreesPromise]);
    return {
      branch,
      repoPath,
      worktrees: results.flatMap((result) => result.worktrees),
      worktreesLoaded: loadWorktrees && results.every((result) => result.loaded),
    };
  }
  return { getInfo };
}

/** Host-selected repositories are the only discovery input; query paths never grant authority. */
export function createGitInfoHandler(
  discovery: ReturnType<typeof createGitInfoDiscovery>,
  config: () => { repoPath: string; repos: Record<string, string> },
): RequestHandler {
  return async (req, res, next) => {
    try {
      const { repoPath, repos } = config();
      res.json(await discovery.getInfo(repoPath, repos, req.query.worktrees === '1'));
    } catch (error) {
      next(error);
    }
  };
}

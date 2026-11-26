import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SessionMeta } from '@mitzo/protocol';
import type { WorktreeCleanupPolicy } from './development-isolation.js';
import type { WorktreeCleanupSummary } from './worktree.js';
import {
  inventoryWorkspaceLifecycle,
  summarizeWorkspaceLifecycleInventory,
  type WorkspaceLifecycleClaim,
  type WorkspaceLifecycleInventory,
} from './workspace-lifecycle.js';

const yieldToEventLoop = () => new Promise<void>((resolveYield) => setImmediate(resolveYield));

function physicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Keep the first label for each physical repository so one directory is scanned once. */
export function dedupeRepoEntriesByPath(
  entries: ReadonlyArray<readonly [string, string]>,
  resolvePath: (path: string) => string = physicalPath,
): Array<[string, string]> {
  const seen = new Set<string>();
  const unique: Array<[string, string]> = [];
  for (const [label, path] of entries) {
    const key = resolvePath(path);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push([label, path]);
  }
  return unique;
}

/** Project recorded session cwd/worktree paths onto lifecycle claims. The per-session
 * lookups are synchronous SQLite reads, so yield periodically to keep serving requests. */
export async function collectSessionWorkspaceClaims(input: {
  claims: WorkspaceLifecycleClaim[];
  sessions: ReadonlyArray<
    Pick<SessionMeta, 'sessionId' | 'cwd' | 'isActive' | 'conversationSource'>
  >;
  repoLabels: readonly string[];
  latestWorktreePath: (sessionId: string, label: string) => string | null;
  yieldEvery?: number;
}): Promise<WorkspaceLifecycleClaim[]> {
  const { claims } = input;
  const yieldEvery = Math.max(1, input.yieldEvery ?? 50);
  const byPath = new Map(claims.map((claim) => [claim.directory, claim]));
  const labels = [...new Set(input.repoLabels)];
  let processed = 0;
  for (const session of input.sessions) {
    if (processed > 0 && processed % yieldEvery === 0) await yieldToEventLoop();
    processed++;
    const paths = new Set(
      [
        session.cwd,
        ...labels.map((label) => input.latestWorktreePath(session.sessionId, label)),
      ].filter((path): path is string => !!path),
    );
    for (const directory of paths) {
      const known = byPath.get(directory);
      if (known) {
        known.resumeReferences = [...new Set([...known.resumeReferences, session.sessionId])];
        known.activeCommands = Math.max(known.activeCommands, session.isActive ? 1 : 0);
      } else {
        const claim: WorkspaceLifecycleClaim = {
          id: session.sessionId,
          directory,
          ownership: session.conversationSource === 'external_import' ? 'external' : 'unknown',
          state: session.isActive ? 'active' : 'resumable',
          activeCommands: session.isActive ? 1 : 0,
          queuedCommands: 0,
          resumeReferences: [session.sessionId],
          leaseState: 'unknown',
        };
        claims.push(claim);
        byPath.set(directory, claim);
      }
    }
  }
  return claims;
}

/** Run the read-only inventory and log a bounded summary, never the per-entry list. */
export async function reportWorkspaceLifecycleInventory(input: {
  roots: readonly string[];
  claims: readonly WorkspaceLifecycleClaim[];
  sessionsTruncated: boolean;
  correlationMs?: number;
  inventory?: (input: {
    roots: readonly string[];
    claims: readonly WorkspaceLifecycleClaim[];
  }) => Promise<WorkspaceLifecycleInventory>;
  log: (message: string, fields: Record<string, unknown>) => void;
}): Promise<void> {
  const started = performance.now();
  const result = await (input.inventory ?? inventoryWorkspaceLifecycle)({
    roots: input.roots,
    claims: input.claims,
  });
  if (input.sessionsTruncated) result.truncated = true;
  input.log('workspace lifecycle inventory', {
    ...summarizeWorkspaceLifecycleInventory(result, { roots: input.roots }),
    claims: input.claims.length,
    durationMs: Math.round(performance.now() - started),
    ...(input.correlationMs !== undefined
      ? { correlationMs: Math.round(input.correlationMs) }
      : {}),
  });
}

type Cleanup = (
  repoPath: string,
  inboxDir: string | undefined,
  activeWtIds: ReadonlySet<string>,
  policy: WorktreeCleanupPolicy,
) => WorktreeCleanupSummary | void;

interface WorktreeCleanupRunnerOptions {
  repoEntries: ReadonlyArray<readonly [string, string]>;
  inboxDir?: string;
  cleanupPolicy: WorktreeCleanupPolicy;
  collectActiveWtIds: () => ReadonlySet<string>;
  cleanup: Cleanup;
  inventory?: () => Promise<void>;
  onError: (label: string, phase: 'startup' | 'periodic', error: unknown) => void;
}

/** Build the single runner used by startup and periodic cleanup. */
export function runWorktreeCleanupForRepos(options: WorktreeCleanupRunnerOptions) {
  let pendingInventory: Promise<void> | undefined;
  return (phase: 'startup' | 'periodic'): Promise<void> => {
    const activeWtIds = options.collectActiveWtIds();
    for (const [label, repoPath] of options.repoEntries) {
      try {
        options.cleanup(repoPath, options.inboxDir, activeWtIds, options.cleanupPolicy);
      } catch (error: unknown) {
        options.onError(label, phase, error);
      }
    }
    if (options.inventory && !pendingInventory) {
      const inventory = options.inventory;
      // Start now, coalesce later ticks, and report failures without allowing a
      // rejected fire-and-forget task to escape the maintenance owner.
      try {
        pendingInventory = inventory()
          .catch((error: unknown) => {
            options.onError('workspace lifecycle inventory', phase, error);
          })
          .finally(() => {
            pendingInventory = undefined;
          });
      } catch (error: unknown) {
        options.onError('workspace lifecycle inventory', phase, error);
      }
    }
    return pendingInventory ?? Promise.resolve();
  };
}

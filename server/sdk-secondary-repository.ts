import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventStore } from './event-store.js';
import { AuthoritySnapshot } from './sandbox-authority.js';
import { captureLocalRepository, type LocalRepositorySource } from './local-repository-worktree.js';
import { createWorktreeAsync, type SafeLocalWorktreeFilesystem } from './worktree.js';
import { sdkSecondaryRepositoryFilesystem } from './sdk-secondary-repository-filesystem.js';
import {
  snapshotRepositoryTaskCheckout,
  validateRepositoryTaskCheckout,
  type RepositoryTaskCheckout,
} from './repository-task-checkout.js';
import type { RepositoryBaseIntent } from './local-repository-base.js';
import type { ManagedSession } from '@mitzo/harness';

const activeTasks = new WeakMap<
  ManagedSession,
  { conversationId: string; tasks: Map<string, RepositoryTaskCheckout> }
>();
export async function retainSdkSecondaryRepositoryTask(
  session: ManagedSession,
  events: Events,
  conversationId: string,
  directory: string,
) {
  if (session.sessionId !== conversationId) throw Error('Original Claude task session changed');
  const task = await sdkSecondaryRepositoryTask(events, conversationId, directory);
  if (!task || session.sessionId !== conversationId)
    throw Error('Completed Claude repository task is unavailable');
  let active = activeTasks.get(session);
  if (active && active.conversationId !== conversationId)
    throw Error('Original Claude task session changed');
  if (!active) {
    active = { conversationId, tasks: new Map() };
    activeTasks.set(session, active);
  }
  active.tasks.set(directory, task);
}
export async function currentSdkSecondaryRepositoryTask(
  session: ManagedSession,
  directory: string,
) {
  const active = activeTasks.get(session);
  const task = active?.tasks.get(directory);
  if (!task) return undefined;
  if (
    session.sessionId !== active!.conversationId ||
    ![...session.worktreePaths.values()].some((entry) => entry.path === directory)
  )
    throw Error('Original Claude repository task is no longer attached');
  return validateRepositoryTaskCheckout(directory, task);
}

type Events = Pick<EventStore, 'getSessionWorktreeRecords' | 'append' | 'getEventsOfType'>;

/** Durable intent written before the first Git effect. Its own event type keeps
 * pending paths out of the completed worktree_opened ledger and client views. */
const ALLOCATION = 'sdk_secondary_allocation';
interface AllocationIntent {
  repoName: string;
  path: string;
  branch: string;
  sourcePath: string;
  baseOid: string;
  localSource: LocalRepositorySource;
  /** 'materialized' is appended only after Git reported a complete checkout. */
  stage: 'allocating' | 'materialized';
}
function recordAllocation(
  events: Events,
  conversationId: string,
  intent: AllocationIntent,
): AllocationIntent {
  events.append(conversationId, ALLOCATION, {
    v: 1,
    type: ALLOCATION,
    ts: Date.now(),
    sessionId: conversationId,
    ...intent,
  });
  return intent;
}
/** Latest intent per task that has no completed ownership record yet. */
function incompleteAllocations(events: Events, conversationId: string) {
  const completed = new Set(
    events.getSessionWorktreeRecords(conversationId).map((record) => record.repoName),
  );
  const latest = new Map<string, AllocationIntent>();
  for (const { payload } of events.getEventsOfType(conversationId, ALLOCATION)) {
    const intent = payload as unknown as AllocationIntent;
    if (typeof intent.repoName !== 'string' || completed.has(intent.repoName)) continue;
    if (!latest.has(intent.repoName)) latest.set(intent.repoName, intent);
  }
  return latest;
}
function recordCompletion(
  events: Events,
  conversationId: string,
  repoName: string,
  task: RepositoryTaskCheckout,
) {
  events.append(conversationId, 'worktree_opened', {
    v: 2,
    type: 'worktree_opened',
    ts: Date.now(),
    sessionId: conversationId,
    repoName,
    path: task.directory,
    sourcePath: task.localSource!.path,
    sdkSecondary: true,
    task,
  });
}
/** Finish an interrupted allocation without ever discarding retained work.
 * Returns undefined only when no checkout exists, so a fresh allocation is safe;
 * Git's own require-new checks still refuse a leftover branch or administration. */
async function reconcileAllocation(
  events: Events,
  conversationId: string,
  intent: AllocationIntent,
  current: () => Promise<void>,
): Promise<RepositoryTaskCheckout | undefined> {
  const preserved = () =>
    `An interrupted Claude repository preparation was preserved at ${intent.path} on branch ${intent.branch}; it was not reopened because it cannot be verified as complete. ` +
    `Inspect it, and only if it holds no needed work, run git -C ${intent.sourcePath} worktree remove ${intent.path} and git -C ${intent.sourcePath} branch -D ${intent.branch} before retrying.`;
  const existing = await lstat(intent.path).catch(unlessMissing);
  if (!existing && intent.stage === 'allocating') return undefined;
  if (intent.stage !== 'materialized') throw Error(preserved());
  let task: RepositoryTaskCheckout;
  try {
    task = await snapshotRepositoryTaskCheckout(intent.path, intent.branch, intent.localSource);
  } catch (cause) {
    throw Error(preserved(), { cause });
  }
  await current();
  recordCompletion(events, conversationId, intent.repoName, task);
  return task;
}

const TASK_ROOT = ['.claude', 'repository-tasks'] as const;
const unlessMissing = (error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
};
/** The sandboxed agent can write inside its workspace, so the unsandboxed
 * controller never follows a link there. Each task-root level is adopted or
 * created one at a time without following links, then the whole ancestor chain
 * is pinned (sandbox-authority) and re-verified before every Git effect. */
async function pinPhysicalTaskRoot(
  workspace: string,
  directory: string,
  filesystem: SafeLocalWorktreeFilesystem,
) {
  let path = workspace;
  for (const level of TASK_ROOT) {
    path = join(path, level);
    let info = await lstat(path).catch(unlessMissing);
    if (!info) {
      // The kernel fence protects writes even if an earlier ancestor changes
      // while this mkdir runs. Physical identity is still checked for adoption.
      await filesystem.mkdir(path);
      info = await lstat(path);
    }
    if (!info.isDirectory() || (await realpath(path)) !== path)
      throw Error('Claude repository task root must be a physical workspace directory');
  }
  const authority = new AuthoritySnapshot();
  authority.capture(path);
  return async () => {
    try {
      authority.verify();
    } catch {
      throw Error('Claude repository task root is no longer the physical workspace directory');
    }
    const leaf = await lstat(directory).catch(unlessMissing);
    if (leaf && (!leaf.isDirectory() || (await realpath(directory)) !== directory))
      throw Error('Claude repository task directory must be physical');
  };
}
function retained(record: Record<string, unknown>): RepositoryTaskCheckout | undefined {
  if (record.sdkSecondary !== true) return undefined;
  const task = record.task as RepositoryTaskCheckout | undefined;
  if (
    !task ||
    task.directory !== record.path ||
    !task.linkedGit ||
    !task.localSource ||
    task.localSource.path !== record.sourcePath
  )
    throw Error('Original Claude repository task record is unavailable');
  return task;
}
export async function sdkSecondaryRepositoryTask(
  events: Pick<Events, 'getSessionWorktreeRecords'>,
  conversationId: string,
  directory: string,
): Promise<RepositoryTaskCheckout | undefined> {
  const record = events
    .getSessionWorktreeRecords(conversationId)
    .find((record) => record.path === directory);
  const task = record && retained(record);
  return task ? validateRepositoryTaskCheckout(directory, task) : undefined;
}

/** Reuse Vertex's isolated worktree materializer and existing completion ledger.
 * The original SDK cwd/history remains intact; each code operation selects this task path. */
export async function prepareSdkSecondaryRepository(options: {
  sourcePath: string;
  workspaceDirectory: string;
  conversationId: string;
  wtId: string;
  base: RepositoryBaseIntent;
  generation?: string;
  events: Events;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
}) {
  const current = async () => {
    options.signal.throwIfAborted();
    await options.assertCurrent();
    options.signal.throwIfAborted();
  };
  await current();
  if ((await realpath(options.sourcePath)) !== options.sourcePath)
    throw Error('Repository source must be physical');
  if ((await realpath(options.workspaceDirectory)) !== options.workspaceDirectory)
    throw Error('Original workspace must be physical');
  const identity = createHash('sha256')
    .update(
      JSON.stringify([
        options.conversationId,
        options.wtId,
        options.workspaceDirectory,
        options.sourcePath,
        options.base,
        options.generation ?? null,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
  const name = `claude-${identity}`;
  const branch = `mitzo/${name}`;
  const taskRoot = join(options.workspaceDirectory, ...TASK_ROOT);
  const directory = join(taskRoot, name);
  const active = {
    state: 'active' as const,
    repoName: name,
    directory,
    branch,
    primaryUnchanged: true,
  };
  const record = options.events
    .getSessionWorktreeRecords(options.conversationId)
    .find((record) => record.repoName === name);
  if (record) {
    if (record.path !== directory || record.sourcePath !== options.sourcePath || !retained(record))
      throw Error('Original Claude repository task changed');
    await validateRepositoryTaskCheckout(directory, retained(record));
    await current();
    return active;
  }
  const pending = incompleteAllocations(options.events, options.conversationId).get(name);
  if (pending) {
    if (
      pending.path !== directory ||
      pending.branch !== branch ||
      pending.sourcePath !== options.sourcePath
    )
      throw Error('Original Claude repository allocation changed');
    await current();
    if (await reconcileAllocation(options.events, options.conversationId, pending, current))
      return active;
  }
  const { localSource, baseOid } = await captureLocalRepository(
    name,
    options.sourcePath,
    options.signal,
    options.base.kind === 'ref' ? options.base.ref : undefined,
  );
  await current();
  // Persist ownership before the first filesystem or Git effect.
  const intent = recordAllocation(options.events, options.conversationId, {
    repoName: name,
    path: directory,
    branch,
    sourcePath: options.sourcePath,
    baseOid,
    localSource,
    stage: 'allocating',
  });
  const filesystem = sdkSecondaryRepositoryFilesystem({
    workspaceDirectory: options.workspaceDirectory,
    commonDirectory: localSource.commonDirectory,
    taskName: name,
    conversationId: options.conversationId,
    signal: options.signal,
    assertCurrent: current,
  });
  const physical = await pinPhysicalTaskRoot(options.workspaceDirectory, directory, filesystem);
  await current();
  await physical();
  await createWorktreeAsync(name, options.sourcePath, {
    dir: taskRoot,
    branch,
    startPoint: baseOid,
    abortSignal: options.signal,
    safeLocalPreparation: true,
    safeLocalFilesystem: filesystem,
    safeLocalRequireNew: true,
    // Authority first, then physical identity closest to each Git effect.
    safeLocalBeforeEffect: async () => {
      await current();
      await physical();
    },
  });
  // Record the completed checkout fact before any further cancellable check.
  recordAllocation(options.events, options.conversationId, { ...intent, stage: 'materialized' });
  await current();
  const task = await snapshotRepositoryTaskCheckout(directory, branch, localSource);
  await current();
  recordCompletion(options.events, options.conversationId, name, task);
  return active;
}

export async function restoreSdkSecondaryRepositories(
  events: Events,
  conversationId: string,
  signal: AbortSignal,
  assertCurrent: () => Promise<void>,
) {
  const result = new Map<string, { path: string; wtId: string }>();
  // A materialized allocation interrupted before its ownership record is
  // completed here; one never verified as complete waits for an explicit retry,
  // which reports where it was preserved instead of blocking this startup.
  for (const intent of incompleteAllocations(events, conversationId).values()) {
    signal.throwIfAborted();
    if (intent.stage !== 'materialized') continue;
    await assertCurrent();
    await reconcileAllocation(events, conversationId, intent, async () => {
      await assertCurrent();
      signal.throwIfAborted();
    });
  }
  for (const record of events.getSessionWorktreeRecords(conversationId)) {
    signal.throwIfAborted();
    const task = retained(record);
    if (!task) continue;
    await assertCurrent();
    await validateRepositoryTaskCheckout(task.directory, task);
    await assertCurrent();
    signal.throwIfAborted();
    if (typeof record.repoName !== 'string')
      throw Error('Original Claude repository name is unavailable');
    result.set(record.repoName, { path: task.directory, wtId: record.repoName });
  }
  return result;
}

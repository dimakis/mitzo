import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventStore } from './event-store.js';
import { AuthoritySnapshot } from './sandbox-authority.js';
import { captureLocalRepository } from './local-repository-worktree.js';
import { createWorktreeAsync } from './worktree.js';
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

type Events = Pick<EventStore, 'getSessionWorktreeRecords' | 'append'>;

const TASK_ROOT = ['.claude', 'repository-tasks'] as const;
const unlessMissing = (error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
};
/** The sandboxed agent can write inside its workspace, so the unsandboxed
 * controller never follows a link there. Each task-root level is adopted or
 * created one at a time without following links, then the whole ancestor chain
 * is pinned (sandbox-authority) and re-verified before every Git effect. */
async function pinPhysicalTaskRoot(workspace: string, directory: string) {
  let path = workspace;
  for (const level of TASK_ROOT) {
    path = join(path, level);
    let info = await lstat(path).catch(unlessMissing);
    if (!info) {
      // mkdir never follows a final-component link; EEXIST is re-inspected below.
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
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
  const record = options.events
    .getSessionWorktreeRecords(options.conversationId)
    .find((record) => record.repoName === name);
  if (record) {
    if (record.path !== directory || record.sourcePath !== options.sourcePath || !retained(record))
      throw Error('Original Claude repository task changed');
    await validateRepositoryTaskCheckout(directory, retained(record));
    await current();
    return { state: 'active' as const, repoName: name, directory, branch, primaryUnchanged: true };
  }
  const { localSource, baseOid } = await captureLocalRepository(
    name,
    options.sourcePath,
    options.signal,
    options.base.kind === 'ref' ? options.base.ref : undefined,
  );
  await current();
  const physical = await pinPhysicalTaskRoot(options.workspaceDirectory, directory);
  await current();
  await physical();
  await createWorktreeAsync(name, options.sourcePath, {
    dir: taskRoot,
    branch,
    startPoint: baseOid,
    abortSignal: options.signal,
    safeLocalPreparation: true,
    safeLocalRequireNew: true,
    // Authority first, then physical identity closest to each Git effect.
    safeLocalBeforeEffect: async () => {
      await current();
      await physical();
    },
  });
  await current();
  const task = await snapshotRepositoryTaskCheckout(directory, branch, localSource);
  await current();
  options.events.append(options.conversationId, 'worktree_opened', {
    v: 2,
    type: 'worktree_opened',
    ts: Date.now(),
    sessionId: options.conversationId,
    repoName: name,
    path: directory,
    sourcePath: options.sourcePath,
    sdkSecondary: true,
    task,
  });
  return { state: 'active' as const, repoName: name, directory, branch, primaryUnchanged: true };
}

export async function restoreSdkSecondaryRepositories(
  events: Pick<Events, 'getSessionWorktreeRecords'>,
  conversationId: string,
  signal: AbortSignal,
  assertCurrent: () => Promise<void>,
) {
  const result = new Map<string, { path: string; wtId: string }>();
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

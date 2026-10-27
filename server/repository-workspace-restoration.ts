import { isDeepStrictEqual } from 'node:util';
import type { RepositoryTaskCheckout } from './repository-task-checkout.js';
import {
  WorkspaceRetirementReceiptSchema,
  type WorkspaceRetirementReceipt,
} from './workspace-preservation.js';

/** Appended only after the original owner restores and verifies a complete local
 * archive. Original creation/adoption receipts remain immutable evidence. */
export interface RepositoryWorkspaceRestoration {
  version: 1;
  revision: number;
  retirement: WorkspaceRetirementReceipt;
  previousTaskIdentity: RepositoryTaskCheckout;
  taskIdentity: RepositoryTaskCheckout;
}
export function restoredRepositoryTaskIdentity(
  record: {
    taskIdentity?: RepositoryTaskCheckout;
    workspaceRevision?: number;
    restorations?: RepositoryWorkspaceRestoration[];
    retirement?: { disposition?: string; receipt: WorkspaceRetirementReceipt };
  },
  original: RepositoryTaskCheckout,
): RepositoryTaskCheckout {
  const unavailable = () => Error('Repository restoration custody chain unavailable');
  const restorations = record.restorations ?? [];
  if (record.retirement && (record.retirement.disposition !== 'restored' || !restorations.length))
    throw unavailable();
  if (
    !Array.isArray(restorations) ||
    restorations.length > 32 ||
    (record.workspaceRevision ?? 0) !== restorations.length
  )
    throw unavailable();
  let previous = original;
  for (let index = 0; index < restorations.length; index++) {
    const item = restorations[index];
    const retirement = WorkspaceRetirementReceiptSchema.parse(item.retirement);
    const task = item.taskIdentity;
    if (
      item.version !== 1 ||
      item.revision !== index + 1 ||
      retirement.state !== 'retired' ||
      retirement.directory !== previous.directory ||
      !isDeepStrictEqual(retirement.rootIdentity, previous.root) ||
      !isDeepStrictEqual(item.previousTaskIdentity, previous) ||
      !task ||
      task.linkedGit ||
      previous.linkedGit ||
      !isDeepStrictEqual({ ...task, root: previous.root, git: previous.git }, previous) ||
      ![task.root.dev, task.root.ino, task.git.dev, task.git.ino].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw unavailable();
    previous = task;
  }
  if (!isDeepStrictEqual(record.taskIdentity, previous)) throw unavailable();
  if (
    restorations.length &&
    !isDeepStrictEqual(record.retirement?.receipt, restorations.at(-1)!.retirement)
  )
    throw unavailable();
  return structuredClone(previous);
}

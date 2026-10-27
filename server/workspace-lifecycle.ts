import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/** Projection of the existing workspace/session owners. This is inventory data,
 * never an enrollment, lease, current authorization, or permission to delete. */
export interface WorkspaceLifecycleClaim {
  id: string;
  directory: string;
  state: 'active' | 'resumable' | 'unused' | 'failed' | 'uncertain' | 'retired';
  ownership: 'owned' | 'external' | 'unknown';
  activeCommands: number;
  queuedCommands: number;
  resumeReferences: readonly string[];
  /** A missing process after restart does not settle its durable lease. */
  leaseState: 'settled' | 'active' | 'unknown';
  protectedReason?: string;
}
export interface WorkspaceLifecycleEntry {
  directory: string;
  claimId?: string;
  disposition: 'protected' | 'archive-required' | 'retired';
  reasons: string[];
}
export interface WorkspaceLifecycleInventory {
  entries: WorkspaceLifecycleEntry[];
  truncated: boolean;
  diagnostics: Array<{ directory: string; reason: string }>;
}
export function planWorkspaceRetirement(claim: WorkspaceLifecycleClaim): WorkspaceLifecycleEntry {
  const reasons: string[] = [];
  if (claim.protectedReason) reasons.push(claim.protectedReason);
  if (claim.ownership !== 'owned')
    reasons.push(claim.ownership === 'external' ? 'external-owner' : 'ownership-unproven');
  if (claim.activeCommands > 0 || claim.state === 'active') reasons.push('active-work');
  if (claim.queuedCommands > 0) reasons.push('queued-work');
  if (claim.resumeReferences.length || claim.state === 'resumable')
    reasons.push('resume-history-reference');
  if (claim.leaseState !== 'settled')
    reasons.push(claim.leaseState === 'active' ? 'active-lease' : 'lease-unreconciled');
  if (claim.state === 'uncertain') reasons.push('operation-uncertain');
  return {
    directory: claim.directory,
    claimId: claim.id,
    disposition: reasons.length
      ? 'protected'
      : claim.state === 'retired'
        ? 'retired'
        : 'archive-required',
    reasons: reasons.length
      ? reasons
      : claim.state === 'retired'
        ? ['retirement-receipt']
        : ['preservation-required'],
  };
}
/** Bounded read-only layout reconciliation. Enumerate only explicit allocation
 * roots and exact claim paths; unknown entries stay protected. No Git commands,
 * age heuristics, symlink traversal, release/staging discovery, or writes. */
export async function inventoryWorkspaceLifecycle(input: {
  roots: readonly string[];
  claims: readonly WorkspaceLifecycleClaim[];
  maxEntries?: number;
  signal?: AbortSignal;
}): Promise<WorkspaceLifecycleInventory> {
  const result: WorkspaceLifecycleInventory = { entries: [], truncated: false, diagnostics: [] };
  const maximum = Math.max(1, Math.min(10000, Math.floor(input.maxEntries ?? 2000)));
  const claims = new Map<string, WorkspaceLifecycleClaim>();
  for (const claim of input.claims) {
    if (!isAbsolute(claim.directory) || resolve(claim.directory) !== claim.directory) {
      result.diagnostics.push({ directory: '', reason: 'invalid-claim-path' });
      continue;
    }
    const previous = claims.get(claim.directory);
    claims.set(
      claim.directory,
      previous && previous.id !== claim.id
        ? { ...claim, ownership: 'unknown', protectedReason: 'conflicting-claims' }
        : claim,
    );
  }
  const seen = new Set<string>();
  const add = async (directory: string) => {
    input.signal?.throwIfAborted();
    if (seen.has(directory)) return;
    if (result.entries.length >= maximum) {
      result.truncated = true;
      return;
    }
    seen.add(directory);
    const claim = claims.get(directory);
    let entry = claim
      ? planWorkspaceRetirement(claim)
      : {
          directory,
          disposition: 'protected' as const,
          reasons: ['ownership-unproven'],
        };
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
        entry = { ...entry, disposition: 'protected', reasons: ['physical-identity-unavailable'] };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        claim?.state === 'retired' &&
        entry.disposition === 'retired'
      ) {
        result.entries.push(entry);
        return;
      }
      entry = {
        ...entry,
        disposition: 'protected',
        reasons: [
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'allocation-missing'
            : 'physical-identity-unavailable',
        ],
      };
    }
    result.entries.push(entry);
  };
  for (const root of [...new Set(input.roots)]) {
    input.signal?.throwIfAborted();
    if (!isAbsolute(root) || resolve(root) !== root) {
      result.diagnostics.push({ directory: '', reason: 'invalid-inventory-root' });
      continue;
    }
    try {
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(root)) !== root) {
        result.diagnostics.push({ directory: root, reason: 'physical-root-unavailable' });
        continue;
      }
      const directory = await opendir(root);
      for await (const entry of directory) {
        if (result.entries.length >= maximum) {
          result.truncated = true;
          break;
        }
        if (entry.isDirectory() || entry.isSymbolicLink()) await add(join(root, entry.name));
      }
    } catch (error) {
      input.signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        result.diagnostics.push({ directory: root, reason: 'inventory-unavailable' });
    }
  }
  for (const directory of claims.keys()) await add(directory);
  return result;
}

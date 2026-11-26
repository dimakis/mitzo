import { lstat, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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

/** Reasons expected for ordinary retained task history; they need no per-entry report. */
const ROUTINE_REASONS: ReadonlySet<string> = new Set([
  'ownership-unproven',
  'external-owner',
  'active-work',
  'queued-work',
  'resume-history-reference',
  'active-lease',
  'lease-unreconciled',
]);
const MAX_SUMMARY_SAMPLE = 20;
const MAX_SUMMARY_KEYS = 32;

export interface WorkspaceLifecycleInventorySummary {
  total: number;
  truncated: boolean;
  nonRoutine: number;
  diagnosticCount: number;
  diagnosticsByReason: Record<string, number>;
  byDisposition: Record<string, number>;
  byReason: Record<string, number>;
  byRoot: Record<string, number>;
  sample: WorkspaceLifecycleEntry[];
}

function increment(counts: Record<string, number>, key: string) {
  if (key in counts || Object.keys(counts).length < MAX_SUMMARY_KEYS)
    counts[key] = (counts[key] ?? 0) + 1;
  else counts.other = (counts.other ?? 0) + 1;
}

/** Log-sized projection of an inventory: counts plus a capped sample of entries
 * that need attention. The size depends on the configured roots, not entry count. */
export function summarizeWorkspaceLifecycleInventory(
  result: WorkspaceLifecycleInventory,
  options: { roots?: readonly string[]; sample?: number } = {},
): WorkspaceLifecycleInventorySummary {
  const sampleLimit = Math.max(
    0,
    Math.min(MAX_SUMMARY_SAMPLE, options.sample ?? MAX_SUMMARY_SAMPLE),
  );
  const roots = new Set(options.roots);
  const summary: WorkspaceLifecycleInventorySummary = {
    total: result.entries.length,
    truncated: result.truncated,
    nonRoutine: 0,
    diagnosticCount: result.diagnostics.length,
    diagnosticsByReason: {},
    byDisposition: {},
    byReason: {},
    byRoot: {},
    sample: [],
  };
  for (const { reason } of result.diagnostics) increment(summary.diagnosticsByReason, reason);
  for (const entry of result.entries) {
    increment(summary.byDisposition, entry.disposition);
    for (const reason of entry.reasons) increment(summary.byReason, reason);
    // Root keys come only from the configured roots; claim paths elsewhere are 'other'.
    const parent = dirname(entry.directory);
    const root = roots.has(parent) ? parent : 'other';
    summary.byRoot[root] = (summary.byRoot[root] ?? 0) + 1;
    if (entry.disposition === 'protected' && entry.reasons.every((r) => ROUTINE_REASONS.has(r)))
      continue;
    summary.nonRoutine++;
    if (summary.sample.length < sampleLimit)
      summary.sample.push({
        directory: entry.directory,
        ...(entry.claimId ? { claimId: entry.claimId } : {}),
        disposition: entry.disposition,
        reasons: entry.reasons.slice(0, 4),
      });
  }
  return summary;
}

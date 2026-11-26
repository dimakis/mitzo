import { afterEach, expect, it } from 'vitest';
import { realpath, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inventoryWorkspaceLifecycle,
  planWorkspaceRetirement,
  summarizeWorkspaceLifecycleInventory,
  type WorkspaceLifecycleEntry,
  type WorkspaceLifecycleClaim,
} from '../workspace-lifecycle.js';

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
const claim = (extra: Partial<WorkspaceLifecycleClaim> = {}): WorkspaceLifecycleClaim => ({
  id: 'owned-task',
  directory: '/owned/task',
  state: 'unused',
  ownership: 'owned',
  activeCommands: 0,
  queuedCommands: 0,
  resumeReferences: [],
  leaseState: 'settled',
  ...extra,
});
it.each([
  [{ ownership: 'external' }, 'external-owner'],
  [{ protectedReason: 'production-release' }, 'production-release'],
  [{ activeCommands: 1 }, 'active-work'],
  [{ queuedCommands: 1 }, 'queued-work'],
  [{ resumeReferences: ['provider-cwd'] }, 'resume-history-reference'],
  [{ leaseState: 'unknown' }, 'lease-unreconciled'],
  [{ state: 'uncertain' }, 'operation-uncertain'],
] as const)('protects durable ownership and references: %j', (extra, reason) => {
  expect(planWorkspaceRetirement(claim(extra))).toMatchObject({
    disposition: 'protected',
    reasons: [reason],
  });
});
it('requires verified preservation even when an owned unused task has clean Git status', () => {
  expect(planWorkspaceRetirement(claim())).toMatchObject({
    disposition: 'archive-required',
    reasons: ['preservation-required'],
  });
});
it('inventories all configured layouts and known custom paths without enrolling unknown files', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-lifecycle-')));
  const locations = [
    'legacy/.claude/worktrees/old',
    'legacy/.cursor/worktrees/cursor',
    'repository-tasks/repo-native',
    'ordinary-tasks/scratch',
    'custom-task',
  ];
  for (const path of locations) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, 'ordinary-tasks', 'unrelated-file'), 'keep');
  const result = await inventoryWorkspaceLifecycle({
    roots: [
      join(root, 'legacy/.claude/worktrees'),
      join(root, 'legacy/.cursor/worktrees'),
      join(root, 'repository-tasks'),
      join(root, 'ordinary-tasks'),
    ],
    claims: [claim({ directory: join(root, 'custom-task'), resumeReferences: ['native-thread'] })],
  });
  expect(result.truncated).toBe(false);
  expect(result.entries).toHaveLength(5);
  expect(result.entries.find((e) => e.directory.endsWith('custom-task'))).toMatchObject({
    claimId: 'owned-task',
    reasons: ['resume-history-reference'],
  });
  expect(
    result.entries.filter((e) => !e.claimId).every((e) => e.reasons.includes('ownership-unproven')),
  ).toBe(true);
});
it('reports bounded incomplete inventory explicitly', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-lifecycle-')));
  for (const path of ['one', 'two']) await mkdir(join(root, path));
  const result = await inventoryWorkspaceLifecycle({ roots: [root], claims: [], maxEntries: 1 });
  expect(result.entries).toHaveLength(1);
  expect(result.truncated).toBe(true);
});

it('reports a verified retired allocation as retired when its live directory is absent', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-lifecycle-')));
  const result = await inventoryWorkspaceLifecycle({
    roots: [],
    claims: [claim({ directory: join(root, 'removed'), state: 'retired' })],
  });
  expect(result.entries[0]).toMatchObject({
    disposition: 'retired',
    reasons: ['retirement-receipt'],
  });
});

it('summarizes a large inventory into bounded counts and a capped non-routine sample', () => {
  const rootA = `/repo/${'a'.repeat(120)}/.claude/worktrees`;
  const rootB = '/repo/.cursor/worktrees';
  const entries: WorkspaceLifecycleEntry[] = Array.from({ length: 5000 }, (_, index) => {
    const root = index % 2 ? rootB : rootA;
    const directory = `${root}/${'session-'.repeat(12)}${index}`;
    if (index % 10 === 0)
      return { directory, disposition: 'protected', reasons: ['physical-identity-unavailable'] };
    if (index % 25 === 1)
      return {
        directory,
        claimId: `claim-${index}`,
        disposition: 'archive-required',
        reasons: ['preservation-required'],
      };
    return {
      directory,
      claimId: `claim-${index}`,
      disposition: 'protected',
      reasons: ['resume-history-reference', 'lease-unreconciled'],
    };
  });
  const summary = summarizeWorkspaceLifecycleInventory(
    {
      entries,
      truncated: true,
      diagnostics: [
        { directory: rootA, reason: 'inventory-unavailable' },
        { directory: '', reason: 'invalid-claim-path' },
      ],
    },
    { roots: [rootA, rootB], sample: 1000 },
  );

  expect(JSON.stringify(summary).length).toBeLessThan(16 * 1024);
  expect(summary).not.toHaveProperty('entries');
  expect(summary).toMatchObject({
    total: 5000,
    truncated: true,
    diagnosticCount: 2,
    diagnosticsByReason: { 'inventory-unavailable': 1, 'invalid-claim-path': 1 },
    byDisposition: { protected: 4800, 'archive-required': 200 },
    byReason: {
      'physical-identity-unavailable': 500,
      'preservation-required': 200,
      'resume-history-reference': 4300,
      'lease-unreconciled': 4300,
    },
    byRoot: { [rootA]: 2500, [rootB]: 2500 },
    nonRoutine: 700,
  });
  expect(summary.sample).toHaveLength(20);
  expect(
    summary.sample.every(
      (entry) =>
        entry.disposition !== 'protected' ||
        entry.reasons.includes('physical-identity-unavailable'),
    ),
  ).toBe(true);
});

it('keeps a routine-only inventory summary free of sampled entries', () => {
  const summary = summarizeWorkspaceLifecycleInventory({
    entries: [
      {
        directory: '/claimed/elsewhere',
        disposition: 'protected',
        reasons: ['ownership-unproven'],
      },
    ],
    truncated: false,
    diagnostics: [],
  });
  expect(summary).toMatchObject({ total: 1, nonRoutine: 0, sample: [], byRoot: { other: 1 } });
});

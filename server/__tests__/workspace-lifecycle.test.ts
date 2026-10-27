import { afterEach, expect, it } from 'vitest';
import { realpath, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inventoryWorkspaceLifecycle,
  planWorkspaceRetirement,
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

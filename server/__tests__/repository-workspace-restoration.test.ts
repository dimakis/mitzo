import { expect, it } from 'vitest';
import { restoredRepositoryTaskIdentity } from '../repository-workspace-restoration.js';
import type { RepositoryTaskCheckout } from '../repository-task-checkout.js';

const original: RepositoryTaskCheckout = {
  directory: '/task',
  featureBranch: 'mitzo/task',
  root: { dev: 1, ino: 1 },
  git: { dev: 1, ino: 2 },
};
const current: RepositoryTaskCheckout = {
  ...original,
  root: { dev: 1, ino: 3 },
  git: { dev: 1, ino: 4 },
};
const retirement = {
  version: 1 as const,
  operationId: 'retirement',
  workspaceId: 'task',
  directory: '/task',
  rootIdentity: original.root,
  state: 'retired' as const,
  archive: {
    version: 1 as const,
    directory: '/archives/task',
    sha256: 'a'.repeat(64),
    files: 3,
    bytes: 200,
  },
};
const record = () => ({
  taskIdentity: current,
  workspaceRevision: 1,
  retirement: { disposition: 'restored', receipt: retirement },
  restorations: [
    {
      version: 1 as const,
      revision: 1,
      retirement,
      previousTaskIdentity: original,
      taskIdentity: current,
    },
  ],
});
it('permits only the exact appended identity without rewriting initial custody', () => {
  expect(restoredRepositoryTaskIdentity(record(), original)).toEqual(current);
  const changed = record();
  changed.restorations[0].taskIdentity = { ...current, featureBranch: 'mitzo/another' };
  expect(() => restoredRepositoryTaskIdentity(changed, original)).toThrow();
});
it('refuses a forged restored disposition without an appended restoration', () => {
  expect(() =>
    restoredRepositoryTaskIdentity(
      { taskIdentity: original, retirement: { disposition: 'restored', receipt: retirement } },
      original,
    ),
  ).toThrow();
});
it('refuses missing or changed archive lineage and busy retirement', () => {
  const changed = record();
  changed.restorations[0].retirement = { ...retirement, rootIdentity: current.root };
  expect(() => restoredRepositoryTaskIdentity(changed, original)).toThrow();
  const busy = record();
  busy.retirement.disposition = 'restoring';
  expect(() => restoredRepositoryTaskIdentity(busy, original)).toThrow();
});

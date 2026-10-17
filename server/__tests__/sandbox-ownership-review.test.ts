import { expect, it } from 'vitest';
import { reviewSandboxOwnership } from '../sandbox-ownership-review.js';
const physical = {
  id: 'physical',
  name: 'legacy',
  phase: 'Stopped',
  workspace: 'default',
  gateway: 'gateway',
};
const owner = {
  conversationId: 'chat',
  physicalId: 'physical',
  sandboxName: 'legacy',
  workspace: 'default',
  gateway: 'gateway',
  accountId: 'work',
  ownerKind: 'ordinary',
  relation: 'runtime',
};
it('exposes exact saved provenance without creating management authority', () => {
  const result = reviewSandboxOwnership(physical, [owner]);
  expect(result.owners).toEqual([owner]);
  expect(result.canDelete).toBe(false);
  expect(result.blockers).toContain('lifecycle_missing');
  expect(result.blockers).toContain('checkpoint_unverified');
});
it.each(['physicalId', 'sandboxName', 'workspace', 'gateway'])(
  'rejects a provenance match with a different %s',
  (field) => {
    expect(reviewSandboxOwnership(physical, [{ ...owner, [field]: 'other' }]).owners).toEqual([]);
  },
);
it('preserves ambiguous owners and migration/Symposium custody as explicit blockers', () => {
  const result = reviewSandboxOwnership(physical, [
    owner,
    { ...owner, conversationId: 'other', ownerKind: 'symposium', relation: 'migration_source' },
  ]);
  expect(result.blockers).toEqual(
    expect.arrayContaining(['ownership_conflict', 'symposium', 'migration']),
  );
});
it('distinguishes no owner and Error resources from ordinary unmanaged conversations', () => {
  expect(reviewSandboxOwnership({ ...physical, phase: 'Error' }, []).blockers).toEqual(
    expect.arrayContaining(['owner_unresolved', 'resource_error']),
  );
});

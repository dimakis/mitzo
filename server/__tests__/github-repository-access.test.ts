import { expect, it, vi } from 'vitest';
import { CapabilityOperationStore } from '../connections/capabilities/operation-store.js';
it('persists repository access for exactly one account, repository and connection revision', () => {
  const store = new CapabilityOperationStore(':memory:');
  const scope = {
    connectionId: 'github',
    connectionRevision: 1,
    accountId: 'one',
    repository: 'example/repo',
  };
  const grant = {
    connectionId: 'github',
    connectionRevision: 1,
    capabilityId: 'github.publish-pr',
    capabilityVersion: 1,
    accountIds: ['one', 'two'],
    status: 'active' as const,
  };
  expect(() => store.approveGithubRepository(scope)).toThrow();
  store.upsertGrant(grant);
  store.approveGithubRepository(scope);
  expect(store.hasGithubRepositoryAccess(scope)).toBe(true);
  expect(store.hasGithubRepositoryAccess({ ...scope, accountId: 'two' })).toBe(false);
  expect(store.hasGithubRepositoryAccess({ ...scope, repository: 'example/other' })).toBe(false);
  expect(store.hasGithubRepositoryAccess({ ...scope, connectionRevision: 2 })).toBe(false);
  expect(() => store.approveGithubRepository({ ...scope, repository: '*' })).toThrow();
  store.upsertGrant({ ...grant, status: 'revoked' });
  expect(store.hasGithubRepositoryAccess(scope)).toBe(false);
  store.upsertGrant(grant);
  expect(store.hasGithubRepositoryAccess(scope)).toBe(false);
  store.approveGithubRepository(scope);
  store.upsertGrant({ ...grant, accountIds: ['two'] });
  store.upsertGrant(grant);
  expect(store.hasGithubRepositoryAccess(scope)).toBe(false);
  store.close();
});

it('changes the grant fence even when revocation and reapproval happen in the same millisecond', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const store = new CapabilityOperationStore(':memory:');
  try {
    const grant = {
      connectionId: 'github',
      connectionRevision: 1,
      capabilityId: 'github.publish-pr',
      capabilityVersion: 1,
      accountIds: ['one'],
      status: 'active' as const,
    };
    const before = store.upsertGrant(grant);
    store.upsertGrant({ ...grant, status: 'revoked' });
    const after = store.upsertGrant(grant);
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
  } finally {
    store.close();
    clock.mockRestore();
  }
});

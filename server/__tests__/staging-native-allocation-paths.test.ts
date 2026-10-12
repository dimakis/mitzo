import { expect, it } from 'vitest';
import { join } from 'node:path';
import {
  canonicalStagingRoot,
  canonicalNativeAllocationPaths,
  requiresCanonicalStaging,
  requiresContainedNativeAllocation,
} from '../symposium-staging-identity.js';
const allocation = '22222222-2222-4222-8222-222222222222';
it('isolates every new canonical native input beneath one exact allocation UUID', () => {
  const root = canonicalStagingRoot(),
    paths = canonicalNativeAllocationPaths(root, allocation);
  expect(paths).toEqual({
    root: join(root, 'symposium/allocations', allocation),
    planDirectory: join(root, 'symposium/allocations', allocation, 'service'),
    repositoryPath: join(root, 'symposium/allocations', allocation, 'workspace'),
    appHome: join(root, 'symposium/allocations', allocation, 'home'),
    configPath: join(root, 'symposium/allocations', allocation, 'settings/owned-host.json'),
    registrationPath: join(
      root,
      'symposium/allocations',
      allocation,
      'settings/staging-registration.json',
    ),
  });
  const plan = {
    planDirectory: paths.planDirectory,
    releaseRoot: join(root, 'releases', 'a'.repeat(12)),
  };
  expect(requiresCanonicalStaging(plan)).toBe(true);
  expect(requiresContainedNativeAllocation(plan)).toBe(allocation);
});
it('refuses a foreign canonical root, traversal and non-UUID allocations', () => {
  expect(() => canonicalNativeAllocationPaths('/private/other', allocation)).toThrow();
  expect(() => canonicalNativeAllocationPaths(canonicalStagingRoot(), '../../old')).toThrow();
  expect(
    requiresContainedNativeAllocation({
      planDirectory: join(canonicalStagingRoot(), 'symposium/service'),
      releaseRoot: '/source',
    }),
  ).toBeUndefined();
});

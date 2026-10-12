import { userInfo } from 'node:os';
import { join } from 'node:path';
import type { OwnedReleasePlan } from './symposium-owned-release.js';
export function canonicalStagingRoot() {
  return join(userInfo().homedir, '.local/share/mitzo-staging');
}
export function canonicalNativeAllocationPaths(root: string, allocation: string) {
  if (
    root !== canonicalStagingRoot() ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(allocation)
  )
    throw Error('Exact canonical native allocation paths required');
  const nativeRoot = join(root, 'symposium/allocations', allocation);
  return Object.freeze({
    root: nativeRoot,
    planDirectory: join(nativeRoot, 'service'),
    repositoryPath: join(nativeRoot, 'workspace'),
    appHome: join(nativeRoot, 'home'),
    configPath: join(nativeRoot, 'settings/owned-host.json'),
    registrationPath: join(nativeRoot, 'settings/staging-registration.json'),
  });
}
export function requiresContainedNativeAllocation(
  plan: Pick<OwnedReleasePlan, 'planDirectory' | 'releaseRoot'>,
) {
  const prefix = join(canonicalStagingRoot(), 'symposium/allocations') + '/';
  if (!plan.planDirectory.startsWith(prefix)) return;
  const match = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/service$/.exec(
    plan.planDirectory.slice(prefix.length),
  );
  if (!match) throw Error('Canonical allocation path refused');
  return match[1];
}
/** Canonical paths cannot be routed through an unregistered/trial launcher. */
export function requiresCanonicalStaging(
  plan: Pick<OwnedReleasePlan, 'planDirectory' | 'releaseRoot'>,
) {
  const root = canonicalStagingRoot();
  return (
    plan.planDirectory === join(root, 'symposium/service') ||
    plan.planDirectory.startsWith(join(root, 'symposium/allocations') + '/') ||
    plan.releaseRoot.startsWith(join(root, 'releases') + '/') ||
    plan.planDirectory.endsWith('/symposium/service')
  );
}

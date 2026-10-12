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
/** Metadata routing only. Physical original-owner validation is still required;
 * neither a topology record nor these paths restore native capabilities. */
export function canonicalOwnedControlPaths(root: string, metadata: unknown) {
  if (root !== canonicalStagingRoot() || !metadata || typeof metadata !== 'object')
    throw Error('Exact canonical owned topology required');
  const input = metadata as Record<string, unknown>;
  if (
    input.mode !== 'owned-custodian' ||
    typeof input.sourceCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(input.sourceCommit) ||
    Object.keys(input).some(
      (key) => !['mode', 'sourceCommit', 'transitionId', 'allocation'].includes(key),
    ) ||
    (input.transitionId !== undefined &&
      (typeof input.transitionId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.transitionId)))
  )
    throw Error('Exact canonical owned topology required');
  if (input.allocation !== undefined) {
    if (typeof input.allocation !== 'string') throw Error('Exact canonical allocation required');
    return Object.freeze({
      ...canonicalNativeAllocationPaths(root, input.allocation),
      sourceCommit: input.sourceCommit,
    });
  }
  return Object.freeze({
    root: join(root, 'symposium'),
    planDirectory: join(root, 'symposium/service'),
    repositoryPath: join(root, 'symposium/workspace'),
    appHome: join(root, 'symposium/home'),
    configPath: join(root, 'symposium/settings/owned-host.json'),
    registrationPath: join(root, 'symposium/settings/staging-registration.json'),
    sourceCommit: input.sourceCommit,
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

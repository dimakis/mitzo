import { userInfo } from 'node:os';
import { join } from 'node:path';
import type { OwnedReleasePlan } from './symposium-owned-release.js';
export function canonicalStagingRoot() {
  return join(userInfo().homedir, '.local/share/mitzo-staging');
}
/** Canonical paths cannot be routed through an unregistered/trial launcher. */
export function requiresCanonicalStaging(
  plan: Pick<OwnedReleasePlan, 'planDirectory' | 'releaseRoot'>,
) {
  const root = canonicalStagingRoot();
  return (
    plan.planDirectory === join(root, 'symposium/service') ||
    plan.releaseRoot.startsWith(join(root, 'releases') + '/') ||
    plan.planDirectory.endsWith('/symposium/service')
  );
}

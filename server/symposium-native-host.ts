import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { SymposiumAttemptRegistry } from './symposium-attempt-registry.js';
import {
  createSymposiumSessionRuntime,
  type SymposiumSessionRuntimeDeps,
} from './symposium-session-runtime.js';

/** Configured host-only directory, never a path below the shared sandbox. */
export function initializeSymposiumNativeHost(configuredDir: string) {
  if (!configuredDir || !isAbsolute(configuredDir))
    throw new Error('Native attempt registry requires an explicit absolute host path');
  const directory = resolve(configuredDir);
  if (directory === '/sandbox' || directory.startsWith(`/sandbox${sep}`))
    throw new Error('Native attempt registry cannot live in the shared sandbox');
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(directory);
  const physical = realpathSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    physical === '/sandbox' ||
    physical.startsWith(`/sandbox${sep}`) ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Native attempt registry directory is not private');
  const registry = new SymposiumAttemptRegistry(join(directory, 'claims.db'));
  // Boot reconciliation is intentionally local. A pending remote controller may
  // still run, so no sandbox is reusable until an explicit exact-proof recovery.
  const pending = registry.pending();
  for (const attempt of pending) registry.markUncertain(attempt.claimToken);
  return {
    registry,
    quarantinedClaims: pending.map((attempt) => attempt.claimToken),
    createSessionRuntime(deps: Omit<SymposiumSessionRuntimeDeps, 'attemptRegistry'>) {
      return createSymposiumSessionRuntime({ ...deps, attemptRegistry: registry });
    },
  };
}

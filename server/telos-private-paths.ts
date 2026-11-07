import { dirname, resolve } from 'node:path';
import { selectedTelosDatabaseFiles } from '@mitzo/protocol/telos-sqlite-owners';
import { canonical } from './sandbox-authority.js';
import { registerWorkspaceRuntimeAuthorityPaths } from './workspace-runtime-private-paths.js';

const observedStorageRoots = new Set<string>();

/** Provider-independent, process-lifetime protection for canonical storage.
 * Register selector pointers too: a provider must not redirect the controller's
 * selected storage by replacing an ancestor symlink. Configuration removal does
 * not make a previously selected database or its recovery files public. */
export function telosPrivateStorageRoots(): string[] {
  const directory = dirname(selectedTelosDatabaseFiles().canonical);
  registerWorkspaceRuntimeAuthorityPaths([directory]);
  observedStorageRoots.add(resolve(directory));
  observedStorageRoots.add(canonical(directory));
  return [...observedStorageRoots];
}

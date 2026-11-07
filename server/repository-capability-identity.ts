import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedSession } from '@mitzo/harness';
import { readRepositoryWorkspaceForConversation } from './repository-workspace-runtime.js';

/** The private claim ledger supplies repository membership. Mutable Git config,
 * matching remotes and names supplied by an agent cannot enroll a workspace. */
export function repositoryCapabilityIdentity(session: ManagedSession): string | undefined {
  try {
    if (!session.sessionId || session.ordinaryRuntimeOwner?.location === 'openshell') return;
    const record = readRepositoryWorkspaceForConversation(session.sessionId);
    const physical = (path: string) => {
      if (realpathSync(path) !== path) throw Error('Noncanonical repository');
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Repository unavailable');
      return { dev: stat.dev, ino: stat.ino };
    };
    if (
      !record ||
      record.sandbox ||
      record.directory !== session.cwd ||
      !record.taskIdentity ||
      !isDeepStrictEqual(record.binding, session.accountBinding) ||
      !isDeepStrictEqual(physical(session.cwd!), record.taskIdentity.root)
    )
      return;
    const source = record.localSource;
    if (
      source &&
      (!isDeepStrictEqual(physical(source.path), source.root) ||
        !isDeepStrictEqual(physical(source.commonDirectory), source.commonRoot))
    )
      return;
    return createHash('sha256')
      .update(
        JSON.stringify([
          record.connectionId,
          record.connectionRevision,
          record.repository,
          source ? [source.path, source.root, source.commonDirectory, source.commonRoot] : null,
        ]),
      )
      .digest('hex');
  } catch {
    return;
  }
}

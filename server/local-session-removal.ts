import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { AccountBinding } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces, RepositoryWorkspace } from './repository-workspaces.js';
import type { LocalRemovalPreview } from './session-removal.js';

/** Retirement preserves bytes under the existing workspace owner. A linked
 * worktree has external Git custody and is explicitly retained for review. */
export function createLocalSessionRemoval(deps: {
  events: Pick<EventStore, 'getSession'>;
  workspaces(): RepositoryWorkspaces;
  resolveBinding(accountId: string, model: string): AccountBinding;
  assertStopped(record: Readonly<RepositoryWorkspace>): void;
}) {
  const retained = (): LocalRemovalPreview => ({
    action: 'retain',
    reason:
      'The runtime will stop. This workspace stays at its current location for review; deleting the chat will not reclaim its disk space.',
  });
  const owned = (id: string) => {
    const meta = deps.events.getSession(id);
    if (!meta) throw Error('Chat ownership is unavailable.');
    if (meta.ordinaryWorkspaceId || !meta.repositoryWorkspaceId) return undefined;
    const record = deps.workspaces().getForConversation(id);
    if (
      !record ||
      record.id !== meta.repositoryWorkspaceId ||
      record.conversationId !== id ||
      record.directory !== meta.cwd
    )
      throw Error('Local workspace ownership changed. Review it before removal.');
    return record;
  };
  const preview = (id: string): LocalRemovalPreview => {
    const record = owned(id);
    return !record?.taskIdentity || record.taskIdentity.linkedGit
      ? retained()
      : {
          action: 'retire',
          reason:
            'The owned checkout will be preserved and retired after the runtime stops. Its verified archive and original files remain retained; this does not reclaim their disk space.',
        };
  };
  return {
    preview,
    fingerprint(id: string) {
      const record = owned(id);
      return createHash('sha256')
        .update(
          JSON.stringify({
            action: preview(id).action,
            workspace: record?.id,
            directory: record?.directory,
            binding: record?.binding,
            task: record?.taskIdentity,
          }),
        )
        .digest('hex');
    },
    async release(id: string, assertCurrent: () => void) {
      assertCurrent();
      if (preview(id).action === 'retain') return;
      const record = owned(id)!;
      await deps.workspaces().retireTask(record.id, record.binding, {
        assertCurrent: async (current) => {
          assertCurrent();
          if (
            !isDeepStrictEqual(
              record.binding,
              deps.resolveBinding(record.binding.accountId, record.binding.model),
            ) ||
            current.id !== owned(id)?.id
          )
            throw Error('Current workspace/account authority changed.');
        },
        assertTaskStopped: (current) => {
          assertCurrent();
          deps.assertStopped(current);
        },
      });
      assertCurrent();
      if (owned(id)?.retirement?.receipt.state !== 'retired')
        throw Error(
          'Workspace preservation and retirement are unverified. The chat has been retained.',
        );
    },
  };
}

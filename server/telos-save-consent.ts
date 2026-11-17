import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TelosWorkAssignment } from '@mitzo/protocol';
import type { TelosWorkStore } from './telos-work-store.js';

export interface TelosSaveConsent {
  /** Session grant key bound to the item and the exact current assignment. */
  key: string;
  /** Throws once the assignment is revoked, reassigned or otherwise changed. */
  assertCurrent(): void;
}

function assignedRole(
  work: Pick<TelosWorkStore, 'read'>,
  itemId: string,
  conversationId: string,
  role: string,
  actor: Parameters<TelosWorkStore['read']>[1],
): TelosWorkAssignment | undefined {
  return work
    .read(itemId, actor)
    .assignments.find(
      (entry) =>
        entry.itemId === itemId &&
        entry.role === role &&
        entry.conversation.namespace === 'mitzo' &&
        entry.conversation.conversationId === conversationId,
    );
}

/** Item-scoped artifact save consent, offered only to a conversation holding a
 * current lead or worker assignment on that exact item. The key covers the item
 * and the assignment revision, so another item or a reassignment needs a new
 * card; the assignment is re-read at each save before the commit. */
export function captureTelosSaveConsent(
  work: Pick<TelosWorkStore, 'read'>,
  selectedRole: { itemId: string; role: string } | undefined,
  conversationId: string,
  itemId: string,
  actor: Parameters<TelosWorkStore['read']>[1],
): TelosSaveConsent | undefined {
  if (!selectedRole || selectedRole.itemId !== itemId) return;
  const original = assignedRole(work, itemId, conversationId, selectedRole.role, actor);
  if (!original) return;
  const snapshot = structuredClone(original);
  return {
    key: `telos-save:${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`,
    assertCurrent() {
      const current = assignedRole(work, itemId, conversationId, selectedRole.role, actor);
      if (!isDeepStrictEqual(current, snapshot))
        throw Error('Telos save consent ended: role assignment changed');
    },
  };
}

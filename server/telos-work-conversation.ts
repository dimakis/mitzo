import type { SessionMeta } from '@mitzo/protocol';

/** Deleting an ordinary chat hides its retained metadata. Keep that attribution,
 * but never treat it as available for new work or conversation authority.
 */
export function isAvailableTelosWorkConversation(
  session: Pick<SessionMeta, 'isHidden' | 'conversationSource' | 'sessionType'> | null,
): boolean {
  return (
    !!session &&
    !session.isHidden &&
    session.conversationSource !== 'external_import' &&
    session.sessionType !== 'symposium'
  );
}

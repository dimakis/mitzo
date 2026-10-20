import type Database from 'better-sqlite3';
import {
  CollaborationBeginSchema,
  CollaborationContractError,
} from './collaboration-conversation.js';
import { SessionCollaborationSchema, type SessionCollaboration } from './session-collaboration.js';
import {
  CollaborationSourceSetupSchema,
  type CollaborationSourceSetup,
} from './collaboration-source-setup.js';

/** Internal composition of the existing relationship/request ledger. No new store.
 * A fresh begin is its first successful request, committed with membership and
 * its exact result in one transaction. Later membership shape is insufficient.
 */
export function resolveCollaborationSourceSetup(
  db: Database.Database,
  rawSource: string,
  owners: { available(id: string): boolean; membership(id: string): SessionCollaboration | null },
  fingerprint: (value: unknown) => string,
): CollaborationSourceSetup {
  const sourceConversationId = CollaborationBeginSchema.shape.sessionId.parse(rawSource);
  return db.transaction(() => {
    if (!owners.available(sourceConversationId))
      throw new CollaborationContractError('unavailable_recipient');
    const rows = db
      .prepare(
        `SELECT r.collaboration_id FROM session_collaboration_revisions r
      WHERE NOT EXISTS (SELECT 1 FROM session_collaboration_revisions n
        WHERE n.collaboration_id=r.collaboration_id AND n.revision>r.revision)
      AND EXISTS (SELECT 1 FROM json_each(r.participant_session_ids) WHERE value=?)
      ORDER BY r.collaboration_id LIMIT 2`,
      )
      .all(sourceConversationId) as Array<{ collaboration_id: string }>;
    const unavailable = (
      reason: 'multiple_associations' | 'origin_unverified' | 'foreign_origin',
    ) =>
      CollaborationSourceSetupSchema.parse({ state: 'unavailable', sourceConversationId, reason });
    if (!rows.length)
      return CollaborationSourceSetupSchema.parse({ state: 'unstarted', sourceConversationId });
    if (rows.length !== 1) return unavailable('multiple_associations');
    const group = rows[0].collaboration_id;
    // The single-column origin index also orders its implicit rowid suffix,
    // bounding this read without scanning every later command/request receipt.
    const receipt = db
      .prepare(
        `SELECT request_id,fingerprint,result FROM collaboration_requests
      WHERE collaboration_id=? ORDER BY rowid LIMIT 1`,
      )
      .get(group) as { request_id: string; fingerprint: string; result: string } | undefined;
    if (!receipt) return unavailable('origin_unverified');
    let original: SessionCollaboration;
    try {
      original = SessionCollaborationSchema.parse(JSON.parse(receipt.result));
    } catch {
      return unavailable('origin_unverified');
    }
    if (
      original.collaborationId !== group ||
      original.revision !== 1 ||
      original.participantSessionIds.length !== 1
    )
      return unavailable('origin_unverified');
    const input = CollaborationBeginSchema.safeParse({
      requestId: receipt.request_id,
      sessionId: original.participantSessionIds[0],
    });
    if (!input.success || receipt.fingerprint !== fingerprint({ kind: 'begin', input: input.data }))
      return unavailable('origin_unverified');
    if (input.data.sessionId !== sourceConversationId) return unavailable('foreign_origin');
    const collaboration = owners.membership(group);
    if (!collaboration?.participantSessionIds.includes(sourceConversationId))
      return unavailable('origin_unverified');
    return CollaborationSourceSetupSchema.parse({
      state: 'selected',
      sourceConversationId,
      collaboration,
    });
  })();
}

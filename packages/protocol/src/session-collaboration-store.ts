import type Database from 'better-sqlite3';
import {
  SessionCollaborationIdSchema,
  SessionCollaborationSchema,
  SessionCollaborationUpdateSchema,
  SessionCollaborationListQuerySchema,
  SessionCollaborationError,
  type SessionCollaboration,
} from './session-collaboration.js';

interface CollaborationRow {
  collaboration_id: string;
  revision: number;
  participant_session_ids: string;
}
function decode(row: CollaborationRow): SessionCollaboration {
  return SessionCollaborationSchema.parse({
    version: 1,
    collaborationId: row.collaboration_id,
    revision: row.revision,
    participantSessionIds: JSON.parse(row.participant_session_ids),
  });
}

/** Association history in the existing EventStore DB. No account, work or runtime registry.
 * References deliberately do not cascade when a participant becomes unavailable.
 */
export class SessionCollaborationStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_collaboration_revisions (
      collaboration_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
      participant_session_ids TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (collaboration_id, revision)
    )`);
  }
  get(id: string): SessionCollaboration | null {
    SessionCollaborationIdSchema.parse(id);
    const row = this.db
      .prepare(
        `SELECT collaboration_id, revision, participant_session_ids FROM session_collaboration_revisions
      WHERE collaboration_id=? ORDER BY revision DESC LIMIT 1`,
      )
      .get(id) as CollaborationRow | undefined;
    return row ? decode(row) : null;
  }
  listForSession(sessionId: string, after?: string) {
    SessionCollaborationListQuerySchema.parse({ sessionId, after });
    const rows = this.db
      .prepare(
        `
      SELECT r.collaboration_id, r.revision, r.participant_session_ids
      FROM session_collaboration_revisions r
      WHERE r.collaboration_id > ? AND NOT EXISTS (
        SELECT 1 FROM session_collaboration_revisions newer
        WHERE newer.collaboration_id=r.collaboration_id AND newer.revision>r.revision
      ) AND EXISTS (SELECT 1 FROM json_each(r.participant_session_ids) WHERE value=?)
      ORDER BY r.collaboration_id LIMIT 51
    `,
      )
      .all(after ?? '', sessionId) as CollaborationRow[];
    const collaborations = rows.slice(0, 50).map(decode);
    return {
      collaborations,
      nextCursor: rows.length > 50 ? collaborations[49].collaborationId : null,
    };
  }
  set(id: string, raw: unknown, isLinkable: (sessionId: string) => boolean): SessionCollaboration {
    SessionCollaborationIdSchema.parse(id);
    const input = SessionCollaborationUpdateSchema.parse(raw);
    const ids = [...input.participantSessionIds].sort();
    return this.db
      .transaction(() => {
        const current = this.get(id);
        const same =
          current !== null && JSON.stringify(current.participantSessionIds) === JSON.stringify(ids);
        // Exact recovery of the last metadata mutation is a read, not a new revision.
        if (
          input.expectedRevision !== (current?.revision ?? 0) &&
          !(current && same && input.expectedRevision === current.revision - 1)
        )
          throw new SessionCollaborationError('conflict');
        if (!current && ids.length < 2) throw new SessionCollaborationError('invalid_membership');
        if (current && same) return current;
        const retained = new Set(current?.participantSessionIds);
        // Availability gates new links; retained references survive participant loss.
        for (const member of ids)
          if (!retained.has(member) && !isLinkable(member))
            throw new SessionCollaborationError('not_found');
        const result = SessionCollaborationSchema.parse({
          version: 1,
          collaborationId: id,
          revision: (current?.revision ?? 0) + 1,
          participantSessionIds: ids,
        });
        this.db
          .prepare(
            `INSERT INTO session_collaboration_revisions
        (collaboration_id,revision,participant_session_ids,created_at) VALUES (?,?,?,?)`,
          )
          .run(id, result.revision, JSON.stringify(ids), Date.now());
        return result;
      })
      .immediate();
  }
}

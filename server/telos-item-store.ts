import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export interface TelosItemUpdateInput {
  itemId: string;
  requestId: string;
  expectedRevision: string;
  status?: 'active' | 'acknowledged' | 'completed';
  note: string;
}
interface ItemRow {
  id: string;
  summary: string;
  status: string;
  parent_id: string | null;
  intent: string;
  rationale: string;
  acceptance_criteria: string;
  updated_at: string;
}
interface UpdateRow {
  session_id: string;
  request_id: string;
  note: string;
  old_status: string;
  new_status: string;
  created_at: string;
}

/** Operates on the canonical Telos DB, preserving its existing item/history model. */
export class TelosItemStore {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path, { fileMustExist: true });
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    try {
      this.db
        .prepare(
          'SELECT id,summary,status,parent_id,intent,rationale,acceptance_criteria,updated_at,snoozed_until FROM items LIMIT 1',
        )
        .get();
      this.db.prepare('SELECT item_id,old_status,new_status,changed_at FROM history LIMIT 1').get();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }

  private hasUpdates(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='telos_item_updates'")
      .get();
  }
  private snapshot(itemId: string) {
    const row = this.db.prepare('SELECT * FROM items WHERE id=?').get(itemId) as
      ItemRow | undefined;
    if (!row) throw new Error('Telos item not found');
    const children = this.db
      .prepare('SELECT * FROM items WHERE parent_id=? ORDER BY id')
      .all(itemId) as ItemRow[];
    const updates = this.hasUpdates()
      ? (this.db
          .prepare(
            'SELECT session_id,request_id,note,old_status,new_status,created_at FROM telos_item_updates WHERE item_id=? ORDER BY seq DESC LIMIT 20',
          )
          .all(itemId) as UpdateRow[])
      : [];
    return {
      id: row.id,
      summary: row.summary,
      status: row.status,
      parentId: row.parent_id,
      intent: row.intent,
      rationale: row.rationale,
      acceptanceCriteria: JSON.parse(row.acceptance_criteria || '[]') as string[],
      updatedAt: row.updated_at,
      revision: createHash('sha256')
        .update(JSON.stringify([row, children, updates]))
        .digest('hex'),
      children: children.map((child) => ({
        id: child.id,
        summary: child.summary,
        status: child.status,
      })),
      updates: updates.map((entry) => ({
        sessionId: entry.session_id,
        requestId: entry.request_id,
        note: entry.note,
        oldStatus: entry.old_status,
        status: entry.new_status,
        createdAt: entry.created_at,
      })),
    };
  }

  /** One consistent read; inspection never creates progress tables or changes items. */
  read(itemId: string) {
    return this.db.transaction(() => this.snapshot(itemId))();
  }

  update(input: TelosItemUpdateInput, sessionId: string) {
    if (!sessionId || !input.note.trim()) throw new Error('Session and evidence note required');
    return this.db
      .transaction(() => {
        const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        if (this.hasUpdates()) {
          const previous = this.db
            .prepare(
              'SELECT input_hash,receipt FROM telos_item_updates WHERE session_id=? AND request_id=?',
            )
            .get(sessionId, input.requestId) as { input_hash: string; receipt: string } | undefined;
          if (previous) {
            if (previous.input_hash !== inputHash)
              throw new Error('Update request identity reused with different input');
            return JSON.parse(previous.receipt) as TelosItemUpdateReceipt;
          }
        }
        const before = this.snapshot(input.itemId);
        if (before.revision !== input.expectedRevision)
          throw new Error('Telos item changed; read it again before updating');
        if (input.status === 'completed') {
          const unfinished = this.db
            .prepare(
              `WITH RECURSIVE descendants(id,status) AS (
          SELECT id,status FROM items WHERE parent_id=?
          UNION SELECT i.id,i.status FROM items i JOIN descendants d ON i.parent_id=d.id
        ) SELECT id FROM descendants WHERE status!='completed' LIMIT 1`,
            )
            .get(input.itemId);
          if (unfinished) throw new Error('Unfinished milestones; complete them before the parent');
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS telos_item_updates (
        seq INTEGER PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id),
        session_id TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
        note TEXT NOT NULL, old_status TEXT NOT NULL, new_status TEXT NOT NULL,
        created_at TEXT NOT NULL, receipt TEXT NOT NULL,
        UNIQUE(session_id,request_id));
        CREATE INDEX IF NOT EXISTS telos_item_updates_item ON telos_item_updates(item_id,seq);`);
        const status = input.status ?? before.status;
        const now = new Date().toISOString();
        this.db
          .prepare(
            `UPDATE items SET status=?,updated_at=?,
        snoozed_until=CASE WHEN ?='snoozed' THEN snoozed_until ELSE NULL END WHERE id=?`,
          )
          .run(status, now, status, input.itemId);
        if (status !== before.status)
          this.db
            .prepare(
              'INSERT INTO history(item_id,old_status,new_status,changed_at) VALUES(?,?,?,?)',
            )
            .run(input.itemId, before.status, status, now);
        this.db
          .prepare(
            `INSERT INTO telos_item_updates
        (item_id,session_id,request_id,input_hash,note,old_status,new_status,created_at,receipt)
        VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            input.itemId,
            sessionId,
            input.requestId,
            inputHash,
            input.note,
            before.status,
            status,
            now,
            '{}',
          );
        const item = this.snapshot(input.itemId);
        const receipt = { item, update: item.updates[0] };
        this.db
          .prepare('UPDATE telos_item_updates SET receipt=? WHERE session_id=? AND request_id=?')
          .run(JSON.stringify(receipt), sessionId, input.requestId);
        return receipt;
      })
      .immediate();
  }
}
export type TelosItemUpdateReceipt = {
  item: ReturnType<TelosItemStore['read']>;
  update: ReturnType<TelosItemStore['read']>['updates'][number];
};

import type Database from 'better-sqlite3';

/** Enroll extensions in the existing Telos database. Reads never infer a kind or
 * migrate old single-session hints into assignments. Canonical parent_id guards
 * also cover writes by the Python owner after enrollment.
 */
export function initializeTelosWorkSchema(db: Database.Database) {
  db.transaction(() =>
    db.exec(`
    CREATE TABLE IF NOT EXISTS telos_work_kinds(item_id TEXT PRIMARY KEY REFERENCES items(id),kind TEXT NOT NULL CHECK(kind IN ('coordinator','outcome','work_item')));
    CREATE TABLE IF NOT EXISTS telos_work_links(seq INTEGER PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id),role TEXT NOT NULL,namespace TEXT NOT NULL,conversation_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(item_id,role,namespace,conversation_id));
    CREATE INDEX IF NOT EXISTS telos_work_links_conversation ON telos_work_links(namespace,conversation_id);
    CREATE TABLE IF NOT EXISTS telos_work_assignments(item_id TEXT NOT NULL REFERENCES items(id),role TEXT NOT NULL CHECK(role IN ('lead','worker')),data TEXT NOT NULL,PRIMARY KEY(item_id,role));
    CREATE TABLE IF NOT EXISTS telos_work_assignment_history(seq INTEGER PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telos_work_sources(seq INTEGER PRIMARY KEY,snapshot_id TEXT NOT NULL UNIQUE,item_id TEXT NOT NULL REFERENCES items(id),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telos_work_attempts(seq INTEGER PRIMARY KEY,attempt_id TEXT NOT NULL UNIQUE,item_id TEXT NOT NULL REFERENCES items(id),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telos_work_commands(seq INTEGER PRIMARY KEY,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL,UNIQUE(actor_id,request_id));
    CREATE TABLE IF NOT EXISTS telos_work_role_setups(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,intent TEXT NOT NULL,receipt TEXT,PRIMARY KEY(actor_id,request_id));
    CREATE TABLE IF NOT EXISTS telos_work_role_setup_rejections(request_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,fingerprint TEXT NOT NULL,reason TEXT NOT NULL CHECK(reason IN ('work_revision','reviewed_context')));
    CREATE TRIGGER IF NOT EXISTS telos_work_role_setup_rejections_no_update BEFORE UPDATE ON telos_work_role_setup_rejections BEGIN SELECT RAISE(ABORT,'Role rejection is terminal'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_role_setup_rejections_no_delete BEFORE DELETE ON telos_work_role_setup_rejections BEGIN SELECT RAISE(ABORT,'Role rejection is terminal'); END;
    CREATE TABLE IF NOT EXISTS telos_work_allocation_outbox(attempt_id TEXT PRIMARY KEY REFERENCES telos_work_attempts(attempt_id),actor_id TEXT NOT NULL,configuration TEXT NOT NULL,allocation_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('requested','recorded')));
    CREATE TABLE IF NOT EXISTS telos_work_delegation_requests(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,attempt_id TEXT NOT NULL REFERENCES telos_work_attempts(attempt_id),intent TEXT NOT NULL,receipt TEXT,PRIMARY KEY(actor_id,request_id));
    CREATE INDEX IF NOT EXISTS telos_work_delegation_attempt ON telos_work_delegation_requests(attempt_id);
    CREATE TABLE IF NOT EXISTS telos_work_source_creations(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,packet TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,item_id TEXT REFERENCES items(id),item_revision TEXT,receipt TEXT,PRIMARY KEY(actor_id,request_id));
    CREATE TRIGGER IF NOT EXISTS telos_work_source_creations_immutable BEFORE UPDATE OF actor_id,request_id,input_hash,packet,idempotency_key ON telos_work_source_creations BEGIN SELECT RAISE(ABORT,'Approved source creation is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_sources_no_update BEFORE UPDATE ON telos_work_sources BEGIN SELECT RAISE(ABORT,'Source snapshot is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_sources_no_delete BEFORE DELETE ON telos_work_sources BEGIN SELECT RAISE(ABORT,'Source snapshot is immutable'); END;
  `),
  )();
  // Use the same guard for insertion and reparenting, including canonical writes.
  const guard = `
    SELECT CASE WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.parent_id) THEN RAISE(ABORT,'Work parent not found') END;
    SELECT CASE WHEN NEW.parent_id=NEW.id OR EXISTS(
      WITH RECURSIVE ancestors(id) AS (SELECT NEW.parent_id UNION SELECT i.parent_id FROM items i JOIN ancestors a ON i.id=a.id WHERE i.parent_id IS NOT NULL)
      SELECT 1 FROM ancestors WHERE id=NEW.id
    ) THEN RAISE(ABORT,'Work composition cycle') END;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM telos_work_kinds WHERE item_id=NEW.parent_id AND kind='work_item') THEN RAISE(ABORT,'Work item cannot be a parent') END;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM telos_work_kinds p JOIN telos_work_kinds c ON c.item_id=NEW.id WHERE p.item_id=NEW.parent_id AND p.kind='coordinator' AND c.kind='work_item') THEN RAISE(ABORT,'Coordinator requires outcome or coordinator children') END;
  `;
  const kindGuard = `
    SELECT CASE WHEN NEW.kind='work_item' AND EXISTS(SELECT 1 FROM items WHERE parent_id=NEW.item_id) THEN RAISE(ABORT,'Work item cannot be a parent') END;
    SELECT CASE WHEN NEW.kind='work_item' AND EXISTS(SELECT 1 FROM items i JOIN telos_work_kinds p ON p.item_id=i.parent_id WHERE i.id=NEW.item_id AND p.kind='coordinator') THEN RAISE(ABORT,'Coordinator requires outcome or coordinator children') END;
    SELECT CASE WHEN NEW.kind='coordinator' AND EXISTS(SELECT 1 FROM items i JOIN telos_work_kinds c ON c.item_id=i.id WHERE i.parent_id=NEW.item_id AND c.kind='work_item') THEN RAISE(ABORT,'Coordinator requires outcome or coordinator children') END;
  `;
  db.transaction(() => {
    for (const [suffix, operation] of [
      ['insert', 'INSERT'],
      ['update', 'UPDATE OF parent_id'],
    ] as const)
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS telos_work_parent_${suffix} BEFORE ${operation} ON items BEGIN ${guard} END;`,
      );
    for (const operation of ['INSERT', 'UPDATE'] as const)
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS telos_work_kind_${operation.toLowerCase()} BEFORE ${operation} ON telos_work_kinds BEGIN ${kindGuard} END;`,
      );
  })();
}

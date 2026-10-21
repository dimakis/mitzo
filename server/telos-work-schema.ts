import type Database from 'better-sqlite3';

/** Enroll extensions in the existing Telos database. Reads never infer a kind or
 * migrate old single-session hints into assignments. Canonical parent_id guards
 * also cover writes by the Python owner after enrollment.
 */
export function initializeTelosWorkSchema(db: Database.Database) {
  db.transaction(() =>
    db.exec(`
    CREATE TABLE IF NOT EXISTS telos_work_controls(control_id TEXT PRIMARY KEY,coordinator_item_id TEXT NOT NULL REFERENCES items(id),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telos_work_control_evidence(seq INTEGER PRIMARY KEY,control_id TEXT NOT NULL REFERENCES telos_work_controls(control_id),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telos_work_control_revalidations(control_id TEXT NOT NULL REFERENCES telos_work_controls(control_id),item_id TEXT NOT NULL REFERENCES items(id),main_commit TEXT NOT NULL,work_revision TEXT NOT NULL,evidence_ref TEXT NOT NULL,PRIMARY KEY(control_id,item_id,main_commit,work_revision,evidence_ref));
    CREATE TABLE IF NOT EXISTS telos_work_control_commands(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(actor_id,request_id));
    CREATE TABLE IF NOT EXISTS telos_work_lifecycle(item_id TEXT PRIMARY KEY REFERENCES items(id),data TEXT NOT NULL,purging INTEGER NOT NULL DEFAULT 0 CHECK(purging IN (0,1)));
    CREATE TABLE IF NOT EXISTS telos_work_lifecycle_commands(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(actor_id,request_id));
    CREATE TABLE IF NOT EXISTS telos_work_lifecycle_history(seq INTEGER PRIMARY KEY,item_id TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS telos_work_lifecycle_history_no_update BEFORE UPDATE ON telos_work_lifecycle_history BEGIN SELECT RAISE(ABORT,'Lifecycle history is retained'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_lifecycle_history_no_delete BEFORE DELETE ON telos_work_lifecycle_history BEGIN SELECT RAISE(ABORT,'Lifecycle history is retained'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_lifecycle_commands_no_update BEFORE UPDATE ON telos_work_lifecycle_commands BEGIN SELECT RAISE(ABORT,'Lifecycle receipts are retained'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_lifecycle_commands_no_delete BEFORE DELETE ON telos_work_lifecycle_commands BEGIN SELECT RAISE(ABORT,'Lifecycle receipts are retained'); END;
    DROP TRIGGER IF EXISTS telos_work_lifecycle_delete_guard;
    CREATE TRIGGER telos_work_lifecycle_delete_guard BEFORE DELETE ON items WHEN
      EXISTS(SELECT 1 FROM telos_work_lifecycle WHERE item_id=OLD.id AND purging=0) OR EXISTS(
        WITH RECURSIVE ancestors(id) AS (SELECT OLD.parent_id UNION SELECT i.parent_id FROM items i JOIN ancestors a ON i.id=a.id WHERE i.parent_id IS NOT NULL)
        SELECT 1 FROM ancestors a JOIN telos_work_lifecycle l ON l.item_id=a.id WHERE json_extract(l.data,'$.disposition') IS NOT 'active'
      ) BEGIN SELECT RAISE(ABORT,'Use confirmed Telos lifecycle deletion'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_lifecycle_no_reuse BEFORE INSERT ON items WHEN EXISTS(SELECT 1 FROM telos_work_lifecycle_history WHERE item_id=NEW.id AND json_extract(data,'$.operation')='delete_permanently') BEGIN SELECT RAISE(ABORT,'Deleted Telos identity cannot be reused'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_lifecycle_insert_guard BEFORE INSERT ON items WHEN EXISTS(
      WITH RECURSIVE ancestors(id) AS (SELECT NEW.parent_id UNION SELECT i.parent_id FROM items i JOIN ancestors a ON i.id=a.id WHERE i.parent_id IS NOT NULL)
      SELECT 1 FROM ancestors a JOIN telos_work_lifecycle l ON l.item_id=a.id WHERE json_extract(l.data,'$.disposition')!='active'
    ) BEGIN SELECT RAISE(ABORT,'Restore lifecycle root before adding children'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_lifecycle_reparent_guard BEFORE UPDATE OF parent_id ON items WHEN OLD.parent_id IS NOT NEW.parent_id AND EXISTS(
      WITH RECURSIVE ancestors(id) AS (SELECT OLD.id UNION SELECT NEW.parent_id UNION SELECT i.parent_id FROM items i JOIN ancestors a ON i.id=a.id WHERE i.parent_id IS NOT NULL)
      SELECT 1 FROM ancestors a JOIN telos_work_lifecycle l ON l.item_id=a.id WHERE json_extract(l.data,'$.disposition')!='active'
    ) BEGIN SELECT RAISE(ABORT,'Restore lifecycle root before moving work'); END;
    CREATE TABLE IF NOT EXISTS telos_work_main_publications(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,item_id TEXT NOT NULL REFERENCES items(id),fingerprint TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(actor_id,request_id));
    CREATE TABLE IF NOT EXISTS telos_work_main_publication_acknowledgements(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,merge_commit TEXT NOT NULL,approval_receipt_id TEXT NOT NULL,PRIMARY KEY(actor_id,request_id,merge_commit),FOREIGN KEY(actor_id,request_id) REFERENCES telos_work_main_publications(actor_id,request_id));
    CREATE TRIGGER IF NOT EXISTS telos_work_main_publication_ack_owner BEFORE INSERT ON telos_work_main_publication_acknowledgements WHEN NOT EXISTS (
      SELECT 1 FROM telos_work_main_publications WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id
      AND json_extract(data,'$.state') IN ('uncertain','accepted') AND json_extract(data,'$.pins.contract')='normal-pr-rules-v1'
      AND json_extract(data,'$.approvalReceiptId')=NEW.approval_receipt_id
    ) BEGIN SELECT RAISE(ABORT,'Publication acknowledgement requires its admitted approval'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_main_publication_ack_no_update BEFORE UPDATE ON telos_work_main_publication_acknowledgements BEGIN SELECT RAISE(ABORT,'Publication acknowledgements are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_main_publication_ack_no_delete BEFORE DELETE ON telos_work_main_publication_acknowledgements BEGIN SELECT RAISE(ABORT,'Publication acknowledgements are retained'); END;
    CREATE UNIQUE INDEX IF NOT EXISTS telos_work_main_publications_one_approval ON telos_work_main_publications(json_extract(data,'$.approvalReceiptId')) WHERE json_extract(data,'$.approvalReceiptId') IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS telos_work_main_publications_identity BEFORE UPDATE OF actor_id,request_id,item_id,fingerprint ON telos_work_main_publications BEGIN SELECT RAISE(ABORT,'Publication request identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_main_publications_no_delete BEFORE DELETE ON telos_work_main_publications BEGIN SELECT RAISE(ABORT,'Publication uncertainty and receipts are retained'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_main_publications_pins BEFORE UPDATE OF data ON telos_work_main_publications WHEN json_extract(NEW.data,'$.pins') IS NOT json_extract(OLD.data,'$.pins') BEGIN SELECT RAISE(ABORT,'Publication pins are immutable'); END;
    DROP TRIGGER IF EXISTS telos_work_main_publications_terminal;
    CREATE TRIGGER IF NOT EXISTS telos_work_main_publications_terminal BEFORE UPDATE OF data ON telos_work_main_publications WHEN NOT (
      (json_extract(OLD.data,'$.state')='requested' AND json_extract(NEW.data,'$.state') IN ('denied','uncertain')) OR
      (json_extract(OLD.data,'$.state')='uncertain' AND json_extract(NEW.data,'$.state')='accepted') OR
      (json_extract(OLD.data,'$.state')='uncertain' AND json_extract(NEW.data,'$.state')='uncertain' AND json_extract(OLD.data,'$.remoteMergeCommit') IS NULL AND json_remove(NEW.data,'$.remoteMergeCommit')=json_remove(OLD.data,'$.remoteMergeCommit')) OR
      NEW.data=OLD.data
    ) BEGIN SELECT RAISE(ABORT,'Publication admission and terminal receipts cannot be reset'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_main_publications_observations BEFORE UPDATE OF data ON telos_work_main_publications WHEN
      (json_extract(OLD.data,'$.inspectedMainHead') IS NOT NULL AND json_extract(NEW.data,'$.inspectedMainHead') IS NOT json_extract(OLD.data,'$.inspectedMainHead')) OR
      (json_extract(OLD.data,'$.admittedMainHead') IS NOT NULL AND json_extract(NEW.data,'$.admittedMainHead') IS NOT json_extract(OLD.data,'$.admittedMainHead')) OR
      (json_extract(OLD.data,'$.remoteMergeCommit') IS NOT NULL AND json_extract(NEW.data,'$.remoteMergeCommit') IS NOT json_extract(OLD.data,'$.remoteMergeCommit'))
      BEGIN SELECT RAISE(ABORT,'Publication observations and remote acknowledgement are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_main_publications_approval BEFORE UPDATE OF data ON telos_work_main_publications WHEN json_extract(OLD.data,'$.approvalReceiptId') IS NOT NULL AND json_extract(NEW.data,'$.approvalReceiptId') IS NOT json_extract(OLD.data,'$.approvalReceiptId') BEGIN SELECT RAISE(ABORT,'Publication approval receipt is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_control_evidence_no_update BEFORE UPDATE ON telos_work_control_evidence BEGIN SELECT RAISE(ABORT,'Control evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_control_evidence_no_delete BEFORE DELETE ON telos_work_control_evidence BEGIN SELECT RAISE(ABORT,'Control evidence is immutable'); END;
    CREATE TABLE IF NOT EXISTS telos_work_kinds(item_id TEXT PRIMARY KEY REFERENCES items(id),kind TEXT NOT NULL CHECK(kind IN ('coordinator','outcome','work_item')));
    CREATE TABLE IF NOT EXISTS telos_work_links(seq INTEGER PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id),role TEXT NOT NULL,namespace TEXT NOT NULL,conversation_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(item_id,role,namespace,conversation_id));
    CREATE INDEX IF NOT EXISTS telos_work_links_conversation ON telos_work_links(namespace,conversation_id);
    CREATE TABLE IF NOT EXISTS telos_work_assignments(item_id TEXT NOT NULL REFERENCES items(id),role TEXT NOT NULL CHECK(role IN ('lead','worker')),data TEXT NOT NULL,PRIMARY KEY(item_id,role));
    CREATE TABLE IF NOT EXISTS telos_work_assignment_history(seq INTEGER PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telos_work_sources(seq INTEGER PRIMARY KEY,snapshot_id TEXT NOT NULL UNIQUE,item_id TEXT NOT NULL REFERENCES items(id),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telos_work_attempts(seq INTEGER PRIMARY KEY,attempt_id TEXT NOT NULL UNIQUE,item_id TEXT NOT NULL REFERENCES items(id),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telos_work_commands(seq INTEGER PRIMARY KEY,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL,UNIQUE(actor_id,request_id));
    CREATE TABLE IF NOT EXISTS telos_work_role_setups(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,intent TEXT NOT NULL,receipt TEXT,PRIMARY KEY(actor_id,request_id));
    CREATE TABLE IF NOT EXISTS telos_work_role_presentations(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,selection TEXT NOT NULL,presentation TEXT NOT NULL,sha256 TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS telos_work_role_presentations_no_update BEFORE UPDATE ON telos_work_role_presentations BEGIN SELECT RAISE(ABORT,'Reviewed presentation is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_role_presentations_no_delete BEFORE DELETE ON telos_work_role_presentations BEGIN SELECT RAISE(ABORT,'Reviewed presentation is immutable'); END;
    CREATE TABLE IF NOT EXISTS telos_work_delegation_presentations(attempt_id TEXT PRIMARY KEY REFERENCES telos_work_attempts(attempt_id),presentation_id TEXT NOT NULL REFERENCES telos_work_role_presentations(id),presentation_sha256 TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS telos_work_delegation_presentations_no_update BEFORE UPDATE ON telos_work_delegation_presentations BEGIN SELECT RAISE(ABORT,'Delegated presentation is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_delegation_presentations_no_delete BEFORE DELETE ON telos_work_delegation_presentations BEGIN SELECT RAISE(ABORT,'Delegated presentation is immutable'); END;
    CREATE TABLE IF NOT EXISTS telos_work_role_setup_presentations(request_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,fingerprint TEXT NOT NULL,presentation_id TEXT NOT NULL REFERENCES telos_work_role_presentations(id),presentation_sha256 TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS telos_work_role_setup_presentations_no_update BEFORE UPDATE ON telos_work_role_setup_presentations BEGIN SELECT RAISE(ABORT,'Selected role presentation is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS telos_work_role_setup_presentations_no_delete BEFORE DELETE ON telos_work_role_setup_presentations BEGIN SELECT RAISE(ABORT,'Selected role presentation is immutable'); END;
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

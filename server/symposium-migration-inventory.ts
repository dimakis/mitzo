import Database from 'better-sqlite3';
import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface SymposiumMigrationInventoryPaths {
  conversationDb: string;
  eventDb: string;
  artifactDb: string;
  leaseDb: string;
}

function openReadOnly(path: string): Database.Database | null {
  if (!isAbsolute(path)) throw new Error('Migration inventory requires absolute database paths');
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
    throw new Error('Migration inventory requires an owned regular database');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
}

/** Inventory only. No store constructor is used: those constructors migrate and
 * recover state. Fixed SQL reads existing rows without invoking application code. */
export function inventorySymposiumMigration(paths: SymposiumMigrationInventoryPaths) {
  const conversations = openReadOnly(paths.conversationDb);
  const events = openReadOnly(paths.eventDb);
  const artifacts = openReadOnly(paths.artifactDb);
  const leases = openReadOnly(paths.leaseDb);
  const missingTables = new Set<string>();
  const table = (db: Database.Database | null, name: string) => {
    const exists = Boolean(
      db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
    );
    if (!exists) missingTables.add(name);
    return exists;
  };
  const count = (db: Database.Database | null, name: string, where = '1=1') =>
    table(db, name) && db
      ? (
          db.prepare(`SELECT COUNT(*) AS count FROM ${name} WHERE ${where}`).get() as {
            count: number;
          }
        ).count
      : 0;
  try {
    const hasConversations = table(conversations, 'codex_conversations');
    const ownerColumnPresent =
      hasConversations && conversations
        ? (conversations.pragma('table_info(codex_conversations)') as Array<{ name: string }>).some(
            (column) => column.name === 'owner_kind',
          )
        : false;
    const owners =
      hasConversations && conversations
        ? (conversations
            .prepare(
              `SELECT id${ownerColumnPresent ? ',owner_kind AS ownerKind' : ''}
           FROM codex_conversations ORDER BY id`,
            )
            .all() as Array<{ id: string; ownerKind?: string | null }>)
        : [];
    const ownership = {
      legacyNull: owners.filter((row) => row.ownerKind == null).map((row) => row.id),
      ordinary: owners.filter((row) => row.ownerKind === 'ordinary').map((row) => row.id),
      symposium: owners.filter((row) => row.ownerKind === 'symposium').map((row) => row.id),
      ownerColumnPresent,
    };
    const commands =
      table(conversations, 'codex_commands') && conversations
        ? (conversations
            .prepare(
              `SELECT conversation_id AS conversationId,id AS commandId,status
               FROM codex_commands
              WHERE status IN ('queued','running')
                 OR (status IN ('interrupted','failed') AND recovery_acknowledged=0)
              ORDER BY conversation_id,id`,
            )
            .all() as Array<{ conversationId: string; commandId: string; status: string }>)
        : [];
    const pending = {
      creationRecoveries: count(events, 'symposium_creation_recoveries', 'result_json IS NULL'),
      lifecycleFences: count(events, 'symposium_seat_lifecycle_fences'),
      executingAttempts: count(events, 'symposium_recipient_attempts', "status='executing'"),
      sourceImports: count(
        artifacts,
        'symposium_session_artifacts',
        'source_import_json IS NOT NULL',
      ),
      sourceSeals: count(artifacts, 'symposium_session_artifacts', 'source_seal_json IS NOT NULL'),
      admissionIssued: count(artifacts, 'symposium_session_artifacts', 'admission_issued=1'),
      artifactReservations: count(artifacts, 'symposium_session_artifacts'),
      artifactLeases: count(leases, 'symposium_artifact_leases'),
      artifactRetention: count(leases, 'symposium_artifact_pending_retention'),
    };
    const pendingIdentities = {
      creationRecoveries:
        table(events, 'symposium_creation_recoveries') && events
          ? (events
              .prepare(
                `SELECT session_id AS sessionId,seat_id AS seatId,generation
                 FROM symposium_creation_recoveries WHERE result_json IS NULL
                ORDER BY session_id,seat_id,generation`,
              )
              .all() as Array<{ sessionId: string; seatId: string; generation: number }>)
          : [],
      lifecycleFences:
        table(events, 'symposium_seat_lifecycle_fences') && events
          ? (events
              .prepare(
                `SELECT session_id AS sessionId,seat_id AS seatId
                 FROM symposium_seat_lifecycle_fences ORDER BY session_id,seat_id`,
              )
              .all() as Array<{ sessionId: string; seatId: string }>)
          : [],
      executingAttempts:
        table(events, 'symposium_recipient_attempts') && events
          ? (events
              .prepare(
                `SELECT delivery_id AS deliveryId,seat_id AS seatId
                 FROM symposium_recipient_attempts WHERE status='executing'
                ORDER BY delivery_id,seat_id`,
              )
              .all() as Array<{ deliveryId: string; seatId: string }>)
          : [],
      sourceImports:
        table(artifacts, 'symposium_session_artifacts') && artifacts
          ? (
              artifacts
                .prepare(
                  `SELECT session_id FROM symposium_session_artifacts
                WHERE source_import_json IS NOT NULL ORDER BY session_id`,
                )
                .all() as Array<{ session_id: string }>
            ).map((row) => row.session_id)
          : [],
      artifactLeases:
        table(leases, 'symposium_artifact_leases') && leases
          ? (leases
              .prepare(
                `SELECT token,volume_name AS volumeName,access
                 FROM symposium_artifact_leases ORDER BY token`,
              )
              .all() as Array<{ token: string; volumeName: string; access: string }>)
          : [],
    };
    return { ownership, commands, pending, pendingIdentities, missingTables: [...missingTables] };
  } finally {
    leases?.close();
    artifacts?.close();
    events?.close();
    conversations?.close();
  }
}

/** Offline application rollback rehearsal. It can only refuse or require more
 * proof; a SQLite inventory cannot establish process/physical quiescence or
 * compatibility with an older executable. */
export function rehearseApplicationRollback(
  inventory: ReturnType<typeof inventorySymposiumMigration>,
) {
  const upgradedFences = Object.entries(inventory.pending)
    .filter(([, count]) => count > 0)
    .map(([name]) => name);
  if (upgradedFences.length)
    return {
      decision: 'refused_upgraded_fences' as const,
      authorized: false as const,
      upgradedFences,
    };
  if (inventory.commands.length || inventory.missingTables.length)
    return {
      decision: 'refused_pending_or_unknown_state' as const,
      authorized: false as const,
      upgradedFences,
    };
  return {
    decision: 'requires_independent_quiescence_and_compatibility' as const,
    authorized: false as const,
    upgradedFences,
  };
}

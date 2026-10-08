import Database from 'better-sqlite3';
import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { AccountBindingSchema } from '@mitzo/protocol';

/** Use offline, quiescent copies. This report never authorizes a database update. */
export interface LegacyOwnershipReportPaths {
  conversationDb: string;
  eventDb: string;
}

function openReadOnly(path: string): Database.Database | null {
  if (!isAbsolute(path))
    throw new Error('Legacy ownership report requires absolute database paths');
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
    throw new Error('Legacy ownership report requires an owned regular database');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
}

function columns(db: Database.Database | null, table: string): Set<string> {
  if (!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
    return new Set();
  return new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name),
  );
}

function primaryKey(db: Database.Database | null, table: string, name: string): boolean {
  const keys = (
    (db?.pragma(`table_info(${table})`) as Array<{ name: string; pk: number }> | undefined) ?? []
  ).filter((column) => column.pk > 0);
  return keys.length === 1 && keys[0].name === name;
}

function compareBinding(
  conversation: unknown,
  session: unknown,
): 'match' | 'mismatch' | 'unavailable' {
  try {
    const key: unknown = JSON.parse(String(conversation));
    const account = AccountBindingSchema.safeParse(JSON.parse(String(session)));
    if (
      !account.success ||
      !Array.isArray(key) ||
      key.length !== 4 ||
      !key.every((entry) => typeof entry === 'string')
    )
      return 'unavailable';
    return key[0] === account.data.accountId &&
      key[1] === account.data.provider &&
      key[2] === account.data.model &&
      key[3] === account.data.profileRevision
      ? 'match'
      : 'mismatch';
  } catch {
    return 'unavailable';
  }
}

/**
 * Read-only evidence classification for historical NULL owner_kind rows.
 * Ordinary chat used the exact session ID as its Codex conversation ID, and
 * wrote matching workspace/account binding to both stores. Symposium activation
 * always raised symposium_revision; deactivation retained that revision.
 * A partial match or missing historical discriminator remains unknown.
 */
export function classifyLegacyNullOwnership(paths: LegacyOwnershipReportPaths) {
  const conversations = openReadOnly(paths.conversationDb);
  const events = openReadOnly(paths.eventDb);
  try {
    const conversationColumns = columns(conversations, 'codex_conversations');
    for (const name of ['id', 'binding', 'cwd'])
      if (!conversationColumns.has(name))
        throw new Error(`Legacy ownership report requires codex_conversations.${name}`);
    if (!primaryKey(conversations, 'codex_conversations', 'id'))
      throw new Error('Legacy ownership report requires codex_conversations.id primary key');
    const ownerColumnPresent = conversationColumns.has('owner_kind');
    const rows = conversations!
      .prepare(
        `SELECT id,binding,cwd FROM codex_conversations
         ${ownerColumnPresent ? 'WHERE owner_kind IS NULL' : ''} ORDER BY id`,
      )
      .all() as Array<{ id: string; binding: string; cwd: string }>;
    const eventColumns = columns(events, 'sessions');
    const missingSchema = [
      'session_id',
      'cwd',
      'account_binding',
      'session_type',
      'symposium_config',
      'symposium_revision',
    ]
      .filter((name) => !eventColumns.has(name))
      .map((name) => `sessions.${name}`);
    if (eventColumns.has('session_id') && !primaryKey(events, 'sessions', 'session_id'))
      missingSchema.push('sessions.session_id_primary_key');
    const provenOrdinary: Array<{
      id: string;
      evidence: 'exact_ordinary_session_binding_and_workspace';
    }> = [];
    const unknown: Array<{ id: string; reasons: string[] }> = [];
    const sessionQuery =
      missingSchema.length === 0
        ? events!.prepare(`SELECT cwd,account_binding AS binding,session_type AS type,
            symposium_config AS config,symposium_revision AS revision
            FROM sessions WHERE session_id=?`)
        : null;
    for (const row of rows) {
      if (typeof row.id !== 'string' || !row.id)
        throw new Error('Legacy ownership report found invalid conversation ID');
      if (missingSchema.length) {
        unknown.push({
          id: row.id,
          reasons: missingSchema.map((name) => `missing_schema:${name}`),
        });
        continue;
      }
      const session = sessionQuery!.get(row.id) as
        | {
            cwd: string | null;
            binding: string | null;
            type: string;
            config: string | null;
            revision: number;
          }
        | undefined;
      if (!session) {
        unknown.push({ id: row.id, reasons: ['session_missing'] });
        continue;
      }
      const reasons: string[] = [];
      if (session.type !== 'chat' || session.config !== null || session.revision !== 0)
        reasons.push('symposium_session_state');
      if (typeof row.cwd !== 'string' || !row.cwd || row.cwd !== session.cwd)
        reasons.push('workspace_mismatch');
      const binding = compareBinding(row.binding, session.binding);
      if (binding !== 'match')
        reasons.push(binding === 'mismatch' ? 'binding_mismatch' : 'binding_unavailable');
      if (reasons.length) unknown.push({ id: row.id, reasons });
      else
        provenOrdinary.push({
          id: row.id,
          evidence: 'exact_ordinary_session_binding_and_workspace',
        });
    }
    return {
      ownerColumnPresent,
      missingSchema,
      provenOrdinary,
      unknown,
      automaticConversionAuthorized: false as const,
    };
  } finally {
    events?.close();
    conversations?.close();
  }
}

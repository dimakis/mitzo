import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyLegacyNullOwnership } from '../symposium-legacy-ownership-report.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const binding = {
  accountId: 'private-account',
  accountLabel: 'private-label',
  provider: 'openai-codex',
  model: 'private-model',
  profileRevision: 'private-revision',
};
const conversationBinding = JSON.stringify([
  binding.accountId,
  binding.provider,
  binding.model,
  binding.profileRevision,
]);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'legacy-owners-'));
  roots.push(root);
  const conversationDb = join(root, 'conversations.db');
  const eventDb = join(root, 'events.db');
  const conversations = new Database(conversationDb);
  // Representative pre-owner codex_conversations shape from 6aa2652b.
  conversations.exec(`CREATE TABLE codex_conversations (
    id TEXT PRIMARY KEY, binding TEXT NOT NULL, cwd TEXT NOT NULL, thread_id TEXT,
    thread_generation INTEGER NOT NULL DEFAULT 0, recovery INTEGER NOT NULL DEFAULT 0,
    recovery_strategy TEXT NOT NULL DEFAULT 'resume', tool_surface_revision TEXT,
    rollover_context TEXT);`);
  const events = new Database(eventDb);
  // sessions is migrated by the historical EventStore; Symposium deactivation
  // clears config but deliberately retains symposium_revision.
  events.exec(`CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY, cwd TEXT, account_binding TEXT,
    session_type TEXT NOT NULL DEFAULT 'chat', symposium_config TEXT,
    symposium_revision INTEGER NOT NULL DEFAULT 0);`);
  return { conversationDb, eventDb, conversations, events };
}

function conversation(db: Database.Database, id: string, cwd = '/ordinary/workspace') {
  db.prepare('INSERT INTO codex_conversations(id,binding,cwd) VALUES (?,?,?)').run(
    id,
    conversationBinding,
    cwd,
  );
}

function session(
  db: Database.Database,
  id: string,
  options: {
    cwd?: string;
    binding?: string | null;
    type?: string;
    config?: string | null;
    revision?: number;
  } = {},
) {
  db.prepare(
    `INSERT INTO sessions
    (session_id,cwd,account_binding,session_type,symposium_config,symposium_revision)
    VALUES (?,?,?,?,?,?)`,
  ).run(
    id,
    options.cwd ?? '/ordinary/workspace',
    options.binding === undefined ? JSON.stringify(binding) : options.binding,
    options.type ?? 'chat',
    options.config ?? null,
    options.revision ?? 0,
  );
}

it('proves ordinary ownership only from exact historical session, binding, workspace and zero Symposium revision', () => {
  const f = fixture();
  conversation(f.conversations, 'ordinary');
  session(f.events, 'ordinary');
  conversation(f.conversations, 'orphan');
  const beforeConversation = readFileSync(f.conversationDb);
  const beforeEvent = readFileSync(f.eventDb);
  f.conversations.close();
  f.events.close();

  const report = classifyLegacyNullOwnership(f);
  expect(report.provenOrdinary).toEqual([
    { id: 'ordinary', evidence: 'exact_ordinary_session_binding_and_workspace' },
  ]);
  expect(report.unknown).toEqual([{ id: 'orphan', reasons: ['session_missing'] }]);
  expect(report.automaticConversionAuthorized).toBe(false);
  expect(readFileSync(f.conversationDb)).toEqual(beforeConversation);
  expect(readFileSync(f.eventDb)).toEqual(beforeEvent);
  expect(JSON.stringify(report)).not.toContain('private-');
});

it('keeps deactivated, active, mismatched and malformed rows unknown without reading command content', () => {
  const f = fixture();
  for (const id of [
    'deactivated',
    'active',
    'binding',
    'cwd',
    'malformed',
    'malformed-conversation',
  ])
    conversation(f.conversations, id);
  session(f.events, 'deactivated', { revision: 2 });
  session(f.events, 'active', { type: 'symposium', config: '{}', revision: 1 });
  session(f.events, 'binding', {
    binding: JSON.stringify({ ...binding, accountId: 'different-secret' }),
  });
  session(f.events, 'cwd', { cwd: '/different/path' });
  session(f.events, 'malformed', { binding: '{not json' });
  session(f.events, 'malformed-conversation');
  f.conversations
    .prepare('UPDATE codex_conversations SET binding=? WHERE id=?')
    .run('{not json', 'malformed-conversation');
  f.conversations.exec(`CREATE TABLE codex_commands (
    sequence INTEGER PRIMARY KEY, conversation_id TEXT, id TEXT,
    input TEXT NOT NULL, status TEXT NOT NULL);
    INSERT INTO codex_commands(conversation_id,id,input,status)
      VALUES ('active','secret-command','DO_NOT_PRINT_COMMAND_CONTENT','queued');`);
  f.conversations.close();
  f.events.close();

  const report = classifyLegacyNullOwnership(f);
  expect(report.provenOrdinary).toEqual([]);
  expect(Object.fromEntries(report.unknown.map((row) => [row.id, row.reasons]))).toEqual({
    active: ['symposium_session_state'],
    binding: ['binding_mismatch'],
    cwd: ['workspace_mismatch'],
    deactivated: ['symposium_session_state'],
    malformed: ['binding_unavailable'],
    'malformed-conversation': ['binding_unavailable'],
  });
  expect(JSON.stringify(report)).not.toContain('different-secret');
  expect(JSON.stringify(report)).not.toContain('/different/path');
  expect(JSON.stringify(report)).not.toContain('DO_NOT_PRINT_COMMAND_CONTENT');
});

it('requires the historical discriminator schema and ignores rows already explicitly owned', () => {
  const f = fixture();
  f.conversations.exec('ALTER TABLE codex_conversations ADD COLUMN owner_kind TEXT');
  conversation(f.conversations, 'legacy');
  session(f.events, 'legacy');
  conversation(f.conversations, 'explicit');
  session(f.events, 'explicit');
  f.conversations
    .prepare("UPDATE codex_conversations SET owner_kind='ordinary' WHERE id='explicit'")
    .run();
  f.events.exec('ALTER TABLE sessions RENAME COLUMN symposium_revision TO obsolete_revision');
  f.conversations.close();
  f.events.close();

  const report = classifyLegacyNullOwnership(f);
  expect(report.provenOrdinary).toEqual([]);
  expect(report.unknown).toEqual([
    { id: 'legacy', reasons: ['missing_schema:sessions.symposium_revision'] },
  ]);
  expect(report.missingSchema).toEqual(['sessions.symposium_revision']);
});

it('does not trust a lookalike sessions table without the historical primary key', () => {
  const f = fixture();
  conversation(f.conversations, 'ambiguous');
  f.events.exec(`DROP TABLE sessions;
    CREATE TABLE sessions (
      session_id TEXT, cwd TEXT, account_binding TEXT,
      session_type TEXT, symposium_config TEXT, symposium_revision INTEGER);`);
  session(f.events, 'ambiguous');
  session(f.events, 'ambiguous', { type: 'symposium', config: '{}', revision: 1 });
  f.conversations.close();
  f.events.close();

  const report = classifyLegacyNullOwnership(f);
  expect(report.provenOrdinary).toEqual([]);
  expect(report.unknown).toEqual([
    { id: 'ambiguous', reasons: ['missing_schema:sessions.session_id_primary_key'] },
  ]);
});

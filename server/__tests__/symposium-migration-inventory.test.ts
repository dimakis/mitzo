import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inventorySymposiumMigration,
  rehearseApplicationRollback,
} from '../symposium-migration-inventory.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(upgraded: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'migration-inventory-'));
  roots.push(root);
  const conversationDb = join(root, 'conversations.db');
  const eventDb = join(root, 'events.db');
  const artifactDb = join(root, 'session-artifacts.db');
  const leaseDb = join(root, 'artifact-leases.db');
  const conversations = new Database(conversationDb);
  conversations.exec(`CREATE TABLE codex_conversations (id TEXT PRIMARY KEY${upgraded ? ', owner_kind TEXT' : ''});
    CREATE TABLE codex_commands (conversation_id TEXT,id TEXT,status TEXT,recovery_acknowledged INTEGER);`);
  conversations
    .prepare(`INSERT INTO codex_conversations VALUES (${upgraded ? '?,?' : '?'})`)
    .run(...(upgraded ? ['legacy', null] : ['legacy']));
  if (upgraded)
    conversations
      .prepare('INSERT INTO codex_commands VALUES (?,?,?,?)')
      .run('legacy', 'uncertain-command', 'running', 0);
  conversations.close();
  const events = new Database(eventDb);
  events.exec(`CREATE TABLE symposium_creation_recoveries (session_id TEXT,seat_id TEXT,generation INTEGER,result_json TEXT);
    CREATE TABLE symposium_seat_lifecycle_fences (session_id TEXT,seat_id TEXT);
    CREATE TABLE symposium_recipient_attempts (delivery_id TEXT,seat_id TEXT,status TEXT);
    CREATE TABLE symposium_membership (session_id TEXT,seat_id TEXT,generation INTEGER,state TEXT);
    CREATE TABLE symposium_membership_reconciliation (session_id TEXT,seat_id TEXT,generation INTEGER,status TEXT);`);
  if (upgraded) {
    events
      .prepare('INSERT INTO symposium_creation_recoveries VALUES (?,?,?,NULL)')
      .run('session-1', 'writer', 3);
    events
      .prepare('INSERT INTO symposium_seat_lifecycle_fences VALUES (?,?)')
      .run('session-1', 'writer');
    events
      .prepare('INSERT INTO symposium_recipient_attempts VALUES (?,?,?)')
      .run('delivery-1', 'writer', 'executing');
  }
  events.close();
  const artifacts = new Database(artifactDb);
  artifacts.exec(`CREATE TABLE symposium_session_artifacts (
    session_id TEXT,state TEXT,admission_issued INTEGER,source_import_json TEXT,source_seal_json TEXT);`);
  if (upgraded)
    artifacts
      .prepare('INSERT INTO symposium_session_artifacts VALUES (?,?,?,?,?)')
      .run('session-1', 'ready', 1, '{"credential":"DO_NOT_PRINT"}', null);
  artifacts.close();
  const leases = new Database(leaseDb);
  leases.exec(`CREATE TABLE symposium_artifact_leases (token TEXT,volume_name TEXT,access TEXT);
    CREATE TABLE symposium_artifact_pending_retention (volume_name TEXT);`);
  if (upgraded) {
    leases
      .prepare('INSERT INTO symposium_artifact_leases VALUES (?,?,?)')
      .run('lease-1', 'volume-1', 'writer');
    leases.prepare('INSERT INTO symposium_artifact_pending_retention VALUES (?)').run('volume-1');
  }
  leases.close();
  return { conversationDb, eventDb, artifactDb, leaseDb };
}

it('inventories legacy NULL ownership and unresolved work without replay or data mutation', () => {
  const paths = fixture(true);
  const before = readFileSync(paths.conversationDb);
  const inventory = inventorySymposiumMigration(paths);
  expect(inventory.ownership).toEqual({
    legacyNull: ['legacy'],
    ordinary: [],
    symposium: [],
    ownerColumnPresent: true,
  });
  expect(inventory.commands).toEqual([
    { conversationId: 'legacy', commandId: 'uncertain-command', status: 'running' },
  ]);
  expect(inventory.pending).toMatchObject({
    creationRecoveries: 1,
    lifecycleFences: 1,
    executingAttempts: 1,
    sourceImports: 1,
    artifactLeases: 1,
    artifactRetention: 1,
  });
  expect(inventory.pendingIdentities.creationRecoveries).toEqual([
    { sessionId: 'session-1', seatId: 'writer', generation: 3 },
  ]);
  expect(inventory.pendingIdentities.sourceImports).toEqual(['session-1']);
  expect(inventory.pendingIdentities.artifactLeases).toEqual([
    { volumeName: 'volume-1', access: 'writer' },
  ]);
  expect(JSON.stringify(inventory)).not.toContain('DO_NOT_PRINT');
  expect(JSON.stringify(inventory)).not.toContain('lease-1');
  expect(readFileSync(paths.conversationDb)).toEqual(before);
});

it('treats absent legacy command and artifact columns as unknown while retaining observable work', () => {
  const paths = fixture(false);
  const commands = new Database(paths.conversationDb);
  commands.exec('ALTER TABLE codex_commands DROP COLUMN recovery_acknowledged');
  commands
    .prepare('INSERT INTO codex_commands VALUES (?,?,?)')
    .run('legacy', 'old-running', 'running');
  commands
    .prepare('INSERT INTO codex_commands VALUES (?,?,?)')
    .run('legacy', 'old-interrupted', 'interrupted');
  commands.close();
  const artifacts = new Database(paths.artifactDb);
  artifacts.exec('ALTER TABLE symposium_session_artifacts DROP COLUMN source_import_json');
  artifacts.exec('ALTER TABLE symposium_session_artifacts DROP COLUMN source_seal_json');
  artifacts.exec('ALTER TABLE symposium_session_artifacts DROP COLUMN admission_issued');
  artifacts
    .prepare('INSERT INTO symposium_session_artifacts VALUES (?,?)')
    .run('legacy-session', 'ready');
  artifacts.close();
  const inventory = inventorySymposiumMigration(paths);
  expect(inventory.commands.map((command) => command.commandId)).toEqual([
    'old-interrupted',
    'old-running',
  ]);
  expect(inventory.missingColumns).toEqual(
    expect.arrayContaining([
      'codex_commands.recovery_acknowledged',
      'symposium_session_artifacts.source_import_json',
      'symposium_session_artifacts.source_seal_json',
      'symposium_session_artifacts.admission_issued',
    ]),
  );
  expect(inventory.pending).toMatchObject({
    artifactReservations: 1,
    sourceImports: null,
    sourceSeals: null,
    admissionIssued: null,
  });
  expect(rehearseApplicationRollback(inventory)).toMatchObject({
    decision: 'refused_upgraded_fences',
    authorized: false,
  });
});

it('refuses an empty old artifact schema because the missing fence columns are unknown', () => {
  const paths = fixture(false);
  const artifacts = new Database(paths.artifactDb);
  artifacts.exec('ALTER TABLE symposium_session_artifacts DROP COLUMN source_import_json');
  artifacts.exec('ALTER TABLE symposium_session_artifacts DROP COLUMN source_seal_json');
  artifacts.exec('ALTER TABLE symposium_session_artifacts DROP COLUMN admission_issued');
  artifacts.close();
  const inventory = inventorySymposiumMigration(paths);
  expect(inventory.pending.sourceImports).toBeNull();
  expect(inventory.pending.artifactReservations).toBe(0);
  expect(rehearseApplicationRollback(inventory)).toMatchObject({
    decision: 'refused_pending_or_unknown_state',
    authorized: false,
  });
});

it('refuses application rollback when additive fences remain on disposable upgraded state', () => {
  const inventory = inventorySymposiumMigration(fixture(true));
  expect(rehearseApplicationRollback(inventory)).toMatchObject({
    decision: 'refused_upgraded_fences',
    authorized: false,
  });
});

it('recognizes pre-owner-column legacy rows and never promotes a clean inventory into rollback approval', () => {
  const inventory = inventorySymposiumMigration(fixture(false));
  expect(inventory.ownership).toEqual({
    legacyNull: ['legacy'],
    ordinary: [],
    symposium: [],
    ownerColumnPresent: false,
  });
  expect(rehearseApplicationRollback(inventory)).toMatchObject({
    decision: 'requires_independent_quiescence_and_compatibility',
    authorized: false,
  });
});

it('keeps legacy ownership visible when owned-host ledgers do not exist yet', () => {
  const paths = fixture(false);
  rmSync(paths.artifactDb);
  rmSync(paths.leaseDb);
  const inventory = inventorySymposiumMigration(paths);
  expect(inventory.ownership.legacyNull).toEqual(['legacy']);
  expect(inventory.missingTables).toContain('symposium_session_artifacts');
  expect(inventory.missingTables).toContain('symposium_artifact_leases');
  expect(rehearseApplicationRollback(inventory)).toMatchObject({
    decision: 'refused_pending_or_unknown_state',
    authorized: false,
  });
});

import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inventorySymposiumMigration,
  rehearseApplicationRollback,
} from '../symposium-migration-inventory.js';
import { CapabilityOperationStore } from '../connections/capabilities/operation-store.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(upgraded: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'migration-inventory-'));
  roots.push(root);
  const conversationDb = join(root, 'conversations.db');
  const eventDb = join(root, 'events.db');
  const artifactDb = join(root, 'session-artifacts.db');
  const leaseDb = join(root, 'artifact-leases.db');
  const capabilityDb = join(root, 'capabilities.db');
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
  const capabilities = new CapabilityOperationStore(capabilityDb);
  if (upgraded) {
    for (const capabilityId of ['github.publish-pr', 'other.capability']) {
      const grant = capabilities.upsertGrant({
        connectionId: 'connection-1',
        connectionRevision: 1,
        capabilityId,
        capabilityVersion: 1,
        accountIds: ['account-1'],
        status: 'active',
      });
      capabilities.begin({
        connectionId: 'connection-1',
        connectionRevision: 1,
        capabilityId,
        capabilityVersion: 1,
        grantId: grant.id,
        accountId: 'account-1',
        conversationId: 'session-1',
        turnId: 'turn-1',
        idempotencyKey: capabilityId,
        inputHash: 'input-hash',
      });
    }
  }
  capabilities.close();
  if (upgraded) {
    const raw = new Database(capabilityDb);
    raw
      .prepare(
        "UPDATE capability_operations SET status='verification_pending',approval_input_json=?,recovery_intent_json=? WHERE capability_id='github.publish-pr'",
      )
      .run('{"credential":"DO_NOT_PRINT"}', '{"secret":"DO_NOT_PRINT"}');
    raw
      .prepare(
        "UPDATE capability_operations SET status='running' WHERE capability_id='other.capability'",
      )
      .run();
    raw.close();
  }
  return { conversationDb, eventDb, artifactDb, leaseDb, capabilityDb };
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
    publicationOperations: 1,
  });
  expect(inventory.publication).toEqual({
    status: 'inspected',
    missingPath: false,
    pendingOperations: [
      {
        conversationId: 'session-1',
        status: 'verification_pending',
      },
    ],
  });
  expect(inventory.pendingIdentities.creationRecoveries).toEqual([
    { sessionId: 'session-1', seatId: 'writer', generation: 3 },
  ]);
  expect(inventory.pendingIdentities.sourceImports).toEqual(['session-1']);
  expect(inventory.pendingIdentities.artifactLeases).toEqual([
    { volumeName: 'volume-1', access: 'writer' },
  ]);
  expect(rehearseApplicationRollback(inventory)).toMatchObject({
    decision: 'refused_upgraded_fences',
    blockers: expect.arrayContaining(['unclassified_legacy_ownership', 'publication_operations']),
  });
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
    blockers: expect.arrayContaining(['unclassified_legacy_ownership', 'unknown_schema']),
  });
});

it('refuses an empty old artifact schema because the missing fence columns are unknown', () => {
  const paths = fixture(false);
  const conversations = new Database(paths.conversationDb);
  conversations.exec('DELETE FROM codex_conversations');
  conversations.close();
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
    decision: 'refused_unclassified_legacy_ownership',
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
    decision: 'refused_unclassified_legacy_ownership',
    authorized: false,
  });
});

it('blocks rollback for 82 legacy NULL conversations even with no other pending operations', () => {
  const paths = fixture(false);
  const conversations = new Database(paths.conversationDb);
  const insert = conversations.prepare('INSERT INTO codex_conversations VALUES (?)');
  for (let i = 0; i < 81; i++) insert.run(`legacy-${i}`);
  conversations.close();
  const inventory = inventorySymposiumMigration(paths);
  expect(inventory.ownership.legacyNull).toHaveLength(82);
  expect(rehearseApplicationRollback(inventory)).toMatchObject({
    decision: 'refused_unclassified_legacy_ownership',
    authorized: false,
    blockers: expect.arrayContaining(['unclassified_legacy_ownership']),
  });
});

it('refuses an otherwise clean application rollback for a pending publication alone', () => {
  const paths = fixture(false);
  const conversations = new Database(paths.conversationDb);
  conversations.exec('DELETE FROM codex_conversations');
  conversations.close();
  const capabilities = new CapabilityOperationStore(paths.capabilityDb);
  const grant = capabilities.upsertGrant({
    connectionId: 'connection-1',
    connectionRevision: 1,
    capabilityId: 'github.publish-pr',
    capabilityVersion: 1,
    accountIds: ['account-1'],
    status: 'active',
  });
  capabilities.begin({
    connectionId: 'connection-1',
    connectionRevision: 1,
    capabilityId: 'github.publish-pr',
    capabilityVersion: 1,
    grantId: grant.id,
    accountId: 'account-1',
    conversationId: 'session-1',
    turnId: 'turn-1',
    idempotencyKey: 'publication-only',
    inputHash: 'input-hash',
  });
  capabilities.close();
  const inventory = inventorySymposiumMigration(paths);
  expect(inventory.pending.publicationOperations).toBe(1);
  expect(rehearseApplicationRollback(inventory)).toMatchObject({
    decision: 'refused_upgraded_fences',
    authorized: false,
    blockers: expect.arrayContaining(['publication_operations']),
  });
});

it('treats a missing publication path or schema as unknown rather than no pending publication', () => {
  const paths = fixture(false);
  rmSync(paths.capabilityDb);
  const missingPath = inventorySymposiumMigration(paths);
  expect(missingPath.publication).toMatchObject({
    status: 'unknown',
    missingPath: true,
    pendingOperations: null,
  });
  expect(missingPath.pending.publicationOperations).toBeNull();
  const db = new Database(paths.capabilityDb);
  db.exec('CREATE TABLE legacy_operations (id TEXT)');
  db.close();
  const missingSchema = inventorySymposiumMigration(paths);
  expect(missingSchema.publication).toMatchObject({
    status: 'unknown',
    missingPath: false,
    pendingOperations: null,
  });
  expect(missingSchema.missingTables).toContain('capability_operations');
});

it('treats an incomplete capability operation table as unknown', () => {
  const paths = fixture(false);
  rmSync(paths.capabilityDb);
  const db = new Database(paths.capabilityDb);
  db.exec('CREATE TABLE capability_operations (id TEXT,status TEXT)');
  db.close();
  const inventory = inventorySymposiumMigration(paths);
  expect(inventory.publication).toMatchObject({
    status: 'unknown',
    missingPath: false,
    pendingOperations: null,
  });
  expect(inventory.missingColumns).toEqual(
    expect.arrayContaining([
      'capability_operations.conversation_id',
      'capability_operations.capability_id',
    ]),
  );
  expect(inventory.pending.publicationOperations).toBeNull();
});

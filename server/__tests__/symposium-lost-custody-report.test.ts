import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportLostSymposiumCustody } from '../symposium-lost-custody-report.js';
import { writeCustodianRetirementReceipt } from '../symposium-custodian-retirement.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'symposium-loss-report-'));
  roots.push(root);
  const stateParent = join(root, 'state');
  mkdirSync(stateParent, { mode: 0o700 });
  const eventDb = join(root, 'events.db');
  const events = new Database(eventDb);
  events.exec(`
    CREATE TABLE symposium_membership (session_id TEXT, seat_id TEXT, generation INTEGER, state TEXT);
    CREATE TABLE symposium_membership_reconciliation (session_id TEXT, seat_id TEXT, generation INTEGER, status TEXT);
    CREATE TABLE symposium_seat_sandboxes (session_id TEXT, seat_id TEXT, generation INTEGER, sandbox_name TEXT, physical_id TEXT, state TEXT);
    CREATE TABLE symposium_creation_recoveries (session_id TEXT, seat_id TEXT, generation INTEGER, request_json TEXT, result_json TEXT);
    CREATE TABLE symposium_seat_lifecycle_fences (session_id TEXT, seat_id TEXT, token TEXT);
  `);
  events
    .prepare('INSERT INTO symposium_membership VALUES (?,?,?,?)')
    .run('session-1', 'writer', 1, 'active');
  events
    .prepare('INSERT INTO symposium_membership_reconciliation VALUES (?,?,?,?)')
    .run('session-1', 'writer', 1, 'confirmed');
  events
    .prepare('INSERT INTO symposium_seat_sandboxes VALUES (?,?,?,?,?,?)')
    .run('session-1', 'writer', 1, 'sandbox-1', 'physical-1', 'ready');
  events
    .prepare('INSERT INTO symposium_creation_recoveries VALUES (?,?,?,?,?)')
    .run('session-1', 'writer', 1, '{"credential":"DO_NOT_PRINT"}', null);
  events.close();
  const artifacts = new Database(join(stateParent, 'session-artifacts.db'));
  artifacts.exec(
    'CREATE TABLE symposium_session_artifacts (session_id TEXT, custody TEXT, volume_name TEXT, state TEXT)',
  );
  artifacts
    .prepare('INSERT INTO symposium_session_artifacts VALUES (?,?,?,?)')
    .run('session-1', 'old-launch-path', 'artifact-volume-1', 'ready');
  artifacts.close();
  chmodSync(join(stateParent, 'session-artifacts.db'), 0o600);
  const leases = new Database(join(stateParent, 'artifact-leases.db'));
  leases.exec(
    'CREATE TABLE symposium_artifact_leases (token TEXT, volume_name TEXT, access TEXT, sandbox_name TEXT, sandbox_id TEXT)',
  );
  leases.exec('CREATE TABLE symposium_artifact_pending_retention (driver TEXT, volume_name TEXT)');
  leases
    .prepare('INSERT INTO symposium_artifact_leases VALUES (?,?,?,?,?)')
    .run('lease-1', 'artifact-volume-1', 'writer', 'sandbox-1', 'physical-1');
  leases.close();
  chmodSync(join(stateParent, 'artifact-leases.db'), 0o600);
  return { eventDb, stateParent };
}

it('reports exact retained identities without credentials or claiming physical retirement', () => {
  const input = fixture();
  const before = readFileSync(input.eventDb);
  const report = reportLostSymposiumCustody(input);
  expect(report.disposition).toBe('fenced_requires_authenticated_reconciliation');
  expect(report.memberships).toEqual([
    {
      sessionId: 'session-1',
      seatId: 'writer',
      generation: 1,
      state: 'active',
      reconciliation: 'confirmed',
    },
  ]);
  expect(report.sandboxes).toEqual([
    {
      sessionId: 'session-1',
      seatId: 'writer',
      generation: 1,
      sandboxName: 'sandbox-1',
      physicalId: 'physical-1',
      state: 'ready',
    },
  ]);
  expect(report.artifacts).toEqual([
    { sessionId: 'session-1', volumeName: 'artifact-volume-1', state: 'ready' },
  ]);
  expect(report.leases).toEqual([
    {
      volumeName: 'artifact-volume-1',
      access: 'writer',
      sandboxName: 'sandbox-1',
      physicalId: 'physical-1',
    },
  ]);
  expect(report.pendingCreationRecoveries).toBe(1);
  expect(JSON.stringify(report)).not.toContain('DO_NOT_PRINT');
  expect(JSON.stringify(report)).not.toContain('old-launch-path');
  expect(readFileSync(input.eventDb)).toEqual(before);
});

it('fails closed on missing or untrusted ledgers instead of reporting clean retirement', () => {
  const input = fixture();
  rmSync(join(input.stateParent, 'artifact-leases.db'));
  expect(() => reportLostSymposiumCustody(input)).toThrow();
  const other = fixture();
  writeFileSync(join(other.stateParent, 'artifact-leases.db'), 'not sqlite');
  expect(() => reportLostSymposiumCustody(other)).toThrow();
});

it('does not infer safe retirement from an empty or previously stopped durable inventory', () => {
  const input = fixture();
  const db = new Database(input.eventDb);
  db.prepare('UPDATE symposium_membership SET state=?').run('suspended');
  db.prepare('UPDATE symposium_seat_sandboxes SET state=?').run('stopped');
  db.close();
  const report = reportLostSymposiumCustody(input);
  expect(report.sandboxes).toEqual([]);
  expect(report.memberships[0].state).toBe('suspended');
  expect(report.physicalProof).toBe('unavailable');
  expect(report.disposition).toBe('fenced_requires_authenticated_reconciliation');
});

it('shows abrupt or uncertain loss when no original-owner terminal receipt exists', () => {
  const input = fixture();
  expect(reportLostSymposiumCustody(input)).toMatchObject({
    lastOwnerShutdown: 'unconfirmed',
    retirementReceipt: 'absent',
    physicalProof: 'unavailable',
  });
});

it('keeps a malformed terminal receipt unconfirmed while retaining the inventory', () => {
  const input = fixture();
  writeFileSync(join(input.stateParent, 'custodian-retirement.json'), '{broken', { mode: 0o600 });
  expect(reportLostSymposiumCustody(input)).toMatchObject({
    lastOwnerShutdown: 'unconfirmed',
    retirementReceipt: 'invalid',
    memberships: [{ sessionId: 'session-1', state: 'active' }],
  });
});

it('shows an original-owner terminal receipt only for matching retained custody', () => {
  const input = fixture();
  const gatewayStateDirectory = join(input.stateParent, 'gateway-exact');
  mkdirSync(gatewayStateDirectory, { mode: 0o700 });
  const db = new Database(join(input.stateParent, 'session-artifacts.db'));
  db.prepare('UPDATE symposium_session_artifacts SET custody=?').run(gatewayStateDirectory);
  db.close();
  writeCustodianRetirementReceipt({
    stateParent: input.stateParent,
    gatewayStateDirectory,
    instanceId: 'original-owner',
    controllerGeneration: 1,
  });
  expect(reportLostSymposiumCustody(input)).toMatchObject({
    lastOwnerShutdown: 'unconfirmed',
    retirementReceipt: 'conflicting_state',
  });
  {
    const db = new Database(input.eventDb);
    db.prepare("UPDATE symposium_membership SET state='suspended'").run();
    db.prepare("UPDATE symposium_seat_sandboxes SET state='stopped'").run();
    db.prepare('DELETE FROM symposium_creation_recoveries').run();
    db.close();
    const leases = new Database(join(input.stateParent, 'artifact-leases.db'));
    leases.prepare('DELETE FROM symposium_artifact_leases').run();
    leases.close();
  }
  expect(reportLostSymposiumCustody(input)).toMatchObject({
    lastOwnerShutdown: 'confirmed_at_receipt',
    retirementReceipt: 'matching',
    disposition: 'fenced_requires_authenticated_reconciliation',
  });
  const laterGateway = join(input.stateParent, 'gateway-later');
  mkdirSync(laterGateway, { mode: 0o700 });
  expect(reportLostSymposiumCustody(input)).toMatchObject({
    lastOwnerShutdown: 'unconfirmed',
    retirementReceipt: 'conflicting_state',
  });
  rmSync(laterGateway, { recursive: true });
  {
    const db = new Database(join(input.stateParent, 'session-artifacts.db'));
    db.prepare('UPDATE symposium_session_artifacts SET custody=?').run('another-gateway');
    db.close();
  }
  expect(reportLostSymposiumCustody(input)).toMatchObject({
    lastOwnerShutdown: 'unconfirmed',
    retirementReceipt: 'mismatch',
  });
});

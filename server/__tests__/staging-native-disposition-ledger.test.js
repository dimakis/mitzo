import { afterEach, expect, it, vi } from 'vitest';
import process from 'node:process';
import { mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
const home = vi.hoisted(() => `/private/tmp/mitzo-native-ledger-${process.pid}`);
vi.mock('node:os', () => ({ homedir: () => home }));
import { createContainedNativeDispositionLedger } from '../../scripts/lib/staging-native-disposition-ledger.mjs';
import {
  OFFLINE_CONTAINMENT_TARGET,
  offlineContainmentDigest as digest,
} from '../../scripts/lib/staging-offline-containment-contract.mjs';
afterEach(() => rmSync(home, { recursive: true, force: true }));
function fixture() {
  const root = OFFLINE_CONTAINMENT_TARGET.canonicalRoot;
  mkdirSync(join(root, 'registry'), { recursive: true, mode: 0o700 });
  const db = new Database(join(root, 'registry/staging.db'));
  const original = { ...OFFLINE_CONTAINMENT_TARGET.original, state: 'retirement_uncertain' };
  db.exec(
    'CREATE TABLE policy(id INTEGER PRIMARY KEY,capacity INTEGER); INSERT INTO policy VALUES(1,1); CREATE TABLE launches(launchId TEXT PRIMARY KEY,sourceCommit TEXT,instanceId TEXT,state TEXT,recordJson TEXT);',
  );
  const row = {
    launchId: original.launchId,
    sourceCommit: original.sourceCommit,
    instanceId: original.instanceId,
    state: original.state,
    recordJson: JSON.stringify(original),
  };
  db.prepare('INSERT INTO launches VALUES(?,?,?,?,?)').run(...Object.values(row));
  db.close();
  chmodSync(join(root, 'registry/staging.db'), 0o600);
  const plan = {
    sha256: 'a'.repeat(64),
    originalRowSha256: digest(row),
    facts: {
      canonicalRoot: root,
      capacity: 1,
      allocation: '22222222-2222-4222-8222-222222222222',
      operation: '33333333-3333-4333-8333-333333333333',
      original: row,
      archiveRoot: root + '-quarantine/33333333-3333-4333-8333-333333333333',
      registration: { sourceCommit: 'b'.repeat(40) },
      containmentReceiptSha256: 'c'.repeat(64),
    },
  };
  const guard = vi.fn(),
    auth = vi.fn();
  const ledger = createContainedNativeDispositionLedger({
    root,
    assertOriginalGuard: guard,
    assertNativeAuthorityCurrent: auth,
  });
  return { root, row, plan, ledger, guard, auth };
}
it('appends a distinct disposition while preserving original row and policy, and refuses replay', () => {
  const f = fixture();
  f.ledger.assertAbsent(f.plan);
  f.ledger.append(f.plan);
  const db = new Database(join(f.root, 'registry/staging.db'), { readonly: true });
  expect(db.prepare('SELECT * FROM launches').all()).toEqual([f.row]);
  expect(db.prepare('SELECT capacity FROM policy').get()).toEqual({ capacity: 1 });
  expect(db.prepare('SELECT * FROM native_capacity_dispositions').all()).toHaveLength(1);
  db.close();
  expect(() => f.ledger.assertAbsent(f.plan)).toThrow();
  expect(() => f.ledger.append(f.plan)).toThrow();
  expect(f.guard).toHaveBeenCalled();
  expect(f.auth).toHaveBeenCalled();
});
it('cannot append without the original authenticated process or after original row drift', () => {
  const f = fixture();
  f.auth.mockImplementation(() => {
    throw Error('not authenticated');
  });
  expect(() => f.ledger.append(f.plan)).toThrow();
  f.auth.mockReset();
  const db = new Database(join(f.root, 'registry/staging.db'));
  db.prepare('UPDATE launches SET state=?').run('retired');
  db.close();
  expect(() => f.ledger.append(f.plan)).toThrow();
});

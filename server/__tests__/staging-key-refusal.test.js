import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  classifyKeyRefusal,
  quarantineKeyReservation,
} from '../../scripts/lib/staging-key-refusal.mjs';
const uuid = '1802450e-a87e-45f1-82ce-3c4acdf91a92';
function snapshot() {
  const plan = {
    sourceCommit: '1'.repeat(40),
    buildSha256: '2'.repeat(64),
    configSha256: '3'.repeat(64),
    planDirectory: '/private/owned',
  };
  return {
    contract: 'native-ed25519-before-store-v1',
    operation: '800c57ad-c490-4330-8589-9430462ac8dd',
    lock: { id: '800c57ad-c490-4330-8589-9430462ac8dd', mode: 'ordinary-to-owned' },
    plan,
    row: {
      launchId: uuid,
      ...plan,
      state: 'retirement_uncertain',
      instanceId: null,
      controllerGeneration: 0,
      completedAt: null,
      retirementStateParent: null,
    },
    activation: { target: plan.sourceCommit, operation: '800c57ad-c490-4330-8589-9430462ac8dd' },
    job: { pid: null, state: 'not running', runs: 1, lastExitCode: 1 },
    nativeMandatoryGateVerified: true,
    sourceContractVerified: true,
    gatewayMaterialVerified: true,
    signingAlgorithm: 'rsa',
    publicAlgorithm: 'rsa',
    originalOwnerAbsent: true,
    attestationAbsent: true,
    sessionArtifactLedgerAbsent: true,
    tokenCacheAbsent: true,
    gatewayDatabaseAbsent: true,
    artifactSchemaEmpty: true,
    eventCounts: [0, 0, 0, 0],
    containers: [],
    volumes: [],
    qualified: [
      {
        launchId: 'old',
        classification: 'pre_native_refused',
        recordJson: '{}',
        auditSha256: 'a'.repeat(64),
        archive: '/private/old',
      },
    ],
  };
}
describe('source-bound Ed25519 gate refusal', () => {
  it('classifies only a mandatory pre-resource gate, never native retirement', () =>
    expect(classifyKeyRefusal(snapshot())).toEqual({
      classification: 'pre_resource_refused',
      launchId: uuid,
      nativeRetirement: false,
      adoption: false,
    }));
  it.each([
    'nativeMandatoryGateVerified',
    'sourceContractVerified',
    'gatewayMaterialVerified',
    'originalOwnerAbsent',
    'attestationAbsent',
    'sessionArtifactLedgerAbsent',
    'tokenCacheAbsent',
    'gatewayDatabaseAbsent',
    'artifactSchemaEmpty',
  ])('requires exact true %s', (key) => {
    for (const value of [false, undefined, 1, 'true']) {
      const s = snapshot();
      s[key] = value;
      expect(() => classifyKeyRefusal(s)).toThrow();
    }
  });
  it.each(['signingAlgorithm', 'publicAlgorithm'])('rejects a possibly accepted %s', (key) => {
    const s = snapshot();
    s[key] = 'ed25519';
    expect(() => classifyKeyRefusal(s)).toThrow();
  });
  it('rejects native resources, later application state and unmatched operation', () => {
    for (const change of [
      (s) => s.containers.push({}),
      (s) => s.volumes.push({}),
      (s) => (s.eventCounts[0] = 1),
      (s) => (s.activation.target = 'f'.repeat(40)),
      (s) => (s.job.runs = 2),
      (s) => (s.row.instanceId = 'instance'),
    ]) {
      const s = snapshot();
      change(s);
      expect(() => classifyKeyRefusal(s)).toThrow();
    }
  });
  it('preserves both refusal records and atomically removes only the proven nil-instance launch', () => {
    const s = snapshot(),
      db = new Database(':memory:');
    db.exec(
      'CREATE TABLE policy(id INTEGER,capacity INTEGER);INSERT INTO policy VALUES(1,1);CREATE TABLE launches(launchId TEXT,sourceCommit TEXT,buildSha256 TEXT,configSha256 TEXT,planDirectory TEXT,state TEXT,instanceId TEXT,controllerGeneration INTEGER,completedAt INTEGER,retirementStateParent TEXT);CREATE TABLE qualified_cold_refusals(launchId TEXT PRIMARY KEY,classification TEXT,recordJson TEXT,auditSha256 TEXT,archive TEXT)',
    );
    db.prepare('INSERT INTO launches VALUES(?,?,?,?,?,?,?,?,?,?)').run(...Object.values(s.row));
    db.prepare('INSERT INTO qualified_cold_refusals VALUES(?,?,?,?,?)').run(
      ...Object.values(s.qualified[0]),
    );
    // SQLite column order is deliberately independent of supplied snapshot order.
    s.row = db.prepare('SELECT * FROM launches').get();
    quarantineKeyReservation(db, s, '/private/new', 'b'.repeat(64));
    expect(db.prepare('SELECT COUNT(*) n FROM launches').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM qualified_cold_refusals').get().n).toBe(2);
    expect(
      JSON.parse(
        db.prepare('SELECT recordJson FROM qualified_cold_refusals WHERE launchId=?').get(uuid)
          .recordJson,
      ),
    ).toEqual(s.row);
    db.close();
  });
});

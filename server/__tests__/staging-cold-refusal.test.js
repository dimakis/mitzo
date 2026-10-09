import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  classifyColdRefusal,
  quarantineColdReservation,
  prepareColdRefusal,
} from '../../scripts/lib/staging-cold-refusal.mjs';
const row = {
  launchId: '12345678-1234-1234-1234-123456789abc',
  planDirectory: '/stage/symposium/service',
  sourceCommit: 'a'.repeat(40),
  buildSha256: 'b'.repeat(64),
  configSha256: 'c'.repeat(64),
  state: 'retirement_uncertain',
  instanceId: null,
  controllerGeneration: 0,
  retirementStateParent: null,
  completedAt: null,
};
function snapshot() {
  return {
    contract: 'sealed-macos-restricted-path-lsof-v1',
    operation: '22345678-1234-1234-1234-123456789abc',
    lock: {
      id: '22345678-1234-1234-1234-123456789abc',
      mode: 'ordinary-to-owned',
      target: row.sourceCommit,
    },
    transition: { id: '22345678-1234-1234-1234-123456789abc', target: row.sourceCommit },
    row: { ...row },
    plan: {
      planDirectory: row.planDirectory,
      sourceCommit: row.sourceCommit,
      buildSha256: row.buildSha256,
      configSha256: row.configSha256,
    },
    sourceContractVerified: true,
    sealedSystem: true,
    lookupPathsAbsent: true,
    restrictedProbeError: 'ENOENT',
    job: { pid: null, state: 'not running', runs: 1, lastExitCode: 1 },
    originalOwnerAbsent: true,
    gatewayDirectories: [],
    attestationAbsent: true,
    sessionArtifactLedgerAbsent: true,
    eventCounts: [0, 0, 0, 0],
    artifactSchemaEmpty: true,
    containers: [],
    volumes: [],
  };
}
function registry() {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE launches(' +
      Object.keys(row)
        .map((k) => k + ' ' + (k === 'controllerGeneration' ? 'INTEGER' : 'TEXT'))
        .join(',') +
      ')',
  );
  db.prepare(
    'INSERT INTO launches VALUES(' +
      Object.keys(row)
        .map(() => '?')
        .join(',') +
      ')',
  ).run(...Object.values(row));
  return db;
}
describe('qualified pre-native refusal', () => {
  it('classifies the precise mandatory-gate contradiction without native retirement or adoption', () => {
    expect(classifyColdRefusal(snapshot())).toMatchObject({
      classification: 'pre_native_refused',
      nativeRetirement: false,
      adoption: false,
    });
  });
  it.each([
    'sourceContractVerified',
    'sealedSystem',
    'lookupPathsAbsent',
    'originalOwnerAbsent',
    'attestationAbsent',
    'sessionArtifactLedgerAbsent',
    'artifactSchemaEmpty',
  ])('refuses missing %s proof despite empty native inventory', (key) => {
    const s = snapshot();
    s[key] = false;
    expect(() => classifyColdRefusal(s)).toThrow();
  });
  it.each(['controllerGeneration', 'instanceId', 'state'])(
    'refuses a record that could have acquired custody: %s',
    (key) => {
      const s = snapshot();
      s.row[key] = key === 'controllerGeneration' ? 1 : key === 'instanceId' ? 'owned' : 'active';
      expect(() => classifyColdRefusal(s)).toThrow();
    },
  );
  it.each(['gatewayDirectories', 'containers', 'volumes', 'eventCounts'])(
    'refuses retained or nonzero %s',
    (key) => {
      const s = snapshot();
      s[key] = [1];
      expect(() => classifyColdRefusal(s)).toThrow();
    },
  );
  it('refuses another operation, job run, or startup error', () => {
    for (const change of [
      (s) => (s.lock.id = 'other'),
      (s) => (s.job.runs = 2),
      (s) => (s.restrictedProbeError = 'EACCES'),
    ]) {
      const s = snapshot();
      change(s);
      expect(() => classifyColdRefusal(s)).toThrow();
    }
  });
  it('preserves the entire original reservation in an audited separate disposition, without marking native retirement', () => {
    const db = registry();
    quarantineColdReservation(db, snapshot(), '/private/archive', 'd'.repeat(64));
    expect(db.prepare('SELECT COUNT(*) AS n FROM launches').get().n).toBe(0);
    const q = db.prepare('SELECT * FROM qualified_cold_refusals').get();
    expect(JSON.parse(q.recordJson)).toEqual(row);
    expect(q.classification).toBe('pre_native_refused');
    db.close();
  });
  it('a registry transaction failure rolls back disposition and preserves the exact held row', () => {
    const db = registry();
    db.exec(
      "CREATE TRIGGER refuse_delete BEFORE DELETE ON launches BEGIN SELECT RAISE(ABORT,'retain'); END",
    );
    expect(() =>
      quarantineColdReservation(db, snapshot(), '/private/archive', 'd'.repeat(64)),
    ).toThrow();
    expect(db.prepare('SELECT * FROM launches').get()).toEqual(row);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='qualified_cold_refusals'").get(),
    ).toBeUndefined();
    db.close();
  });
  it('partial preservation never classifies or unlocks the failed original operation', async () => {
    const calls = [];
    await expect(
      prepareColdRefusal({
        validate: async () => calls.push('validate'),
        archive: async () => {
          calls.push('archive');
          throw Error('partial');
        },
        classify: async () => calls.push('classify'),
        vacate: async () => calls.push('vacate'),
        record: async () => calls.push('record'),
        audit: async () => calls.push('audit'),
      }),
    ).rejects.toThrow('partial');
    expect(calls).toEqual(['validate', 'archive', 'audit']);
  });
});

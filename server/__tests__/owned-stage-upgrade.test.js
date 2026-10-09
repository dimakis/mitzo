import { describe, it, expect } from 'vitest';
import {
  runOwnedStageUpgrade,
  archiveRetiredReservation,
} from '../../scripts/lib/owned-stage-upgrade.mjs';
import Database from 'better-sqlite3';
function effects(failure) {
  const calls = [],
    names = [
      'lock',
      'validateLive',
      'retire',
      'verifyRetired',
      'preserveRetired',
      'qualifyRetired',
      'prepareFresh',
      'startFresh',
      'verifyFresh',
      'unlock',
    ];
  return {
    calls,
    fx: Object.fromEntries([
      ...names.map((n) => [
        n,
        async () => {
          calls.push(n);
          if (n === failure) throw Error(n);
        },
      ]),
      ['audit', async (state) => calls.push('audit:' + state)],
    ]),
  };
}
describe('original-owner controlled fresh staging update', () => {
  it('keeps the operation locked through actual retirement, preservation, one fresh start and ownership verification', async () => {
    const t = effects();
    await runOwnedStageUpgrade(t.fx);
    expect(t.calls).toEqual([
      'lock',
      'validateLive',
      'retire',
      'verifyRetired',
      'preserveRetired',
      'qualifyRetired',
      'prepareFresh',
      'startFresh',
      'verifyFresh',
      'audit:verified',
      'unlock',
    ]);
  });
  it.each([
    'retire',
    'verifyRetired',
    'preserveRetired',
    'qualifyRetired',
    'prepareFresh',
    'startFresh',
    'verifyFresh',
  ])('preserves uncertainty and never retries or unlocks after %s fails', async (stage) => {
    const t = effects(stage);
    await expect(runOwnedStageUpgrade(t.fx)).rejects.toThrow();
    expect(t.calls.filter((n) => n === 'startFresh')).toHaveLength(
      ['startFresh', 'verifyFresh'].includes(stage) ? 1 : 0,
    );
    expect(t.calls).not.toContain('unlock');
    expect(t.calls.at(-1)).toBe('audit:uncertain');
  });
  it('a refusal before retirement releases only its own verified lock', async () => {
    const t = effects('validateLive');
    await expect(runOwnedStageUpgrade(t.fx)).rejects.toThrow();
    expect(t.calls).toEqual(['lock', 'validateLive', 'audit:refused', 'unlock']);
  });
  it('preserves the full retired row and requires a source-bound actual retirement validator before vacating the operational slot', () => {
    const db = new Database(':memory:');
    db.exec(
      "CREATE TABLE launches(launchId TEXT, state TEXT, instanceId TEXT, controllerGeneration INTEGER, completedAt INTEGER);INSERT INTO launches VALUES('launch','retired','original',1,123)",
    );
    const row = db.prepare('SELECT * FROM launches').get(),
      proof = { instanceId: 'original', completedAt: 123 };
    let validated = false;
    archiveRetiredReservation(db, row, proof, '/private/archive', 'a'.repeat(64), () => {
      validated = true;
    });
    expect(validated).toBe(true);
    expect(db.prepare('SELECT COUNT(*) n FROM launches').get().n).toBe(0);
    expect(
      JSON.parse(db.prepare('SELECT recordJson FROM retired_owned_launches').get().recordJson),
    ).toEqual(row);
    db.close();
  });
  it('a rejected native receipt cannot vacate a retired row', () => {
    const db = new Database(':memory:');
    db.exec(
      "CREATE TABLE launches(launchId TEXT,state TEXT);INSERT INTO launches VALUES('launch','retired')",
    );
    const row = db.prepare('SELECT * FROM launches').get();
    expect(() =>
      archiveRetiredReservation(db, row, {}, '/private/archive', 'a'.repeat(64), () => {
        throw Error('receipt');
      }),
    ).toThrow();
    expect(db.prepare('SELECT COUNT(*) n FROM launches').get().n).toBe(1);
    db.close();
  });
});

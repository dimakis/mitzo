import { describe, it, expect } from 'vitest';
import {
  createOfflineRecoveryPreparation,
  assertOfflinePreparationStatus,
} from '../../scripts/lib/staging-offline-prepare.mjs';

describe('offline recovery source preparation', () => {
  function fixture() {
    const events = [];
    const target = 'a'.repeat(40);
    const inputs = { target, dependencySource: '/audited', dependencyFingerprint: 'b'.repeat(64) };
    const effects = Object.fromEntries(
      [
        'assertPreparationBoundary',
        'assertSourceAccepted',
        'assertDestinationAbsent',
        'qualifyDependencies',
        'cloneAcceptedSource',
        'copyDependencies',
        'buildApplication',
        'compileOperatorHelper',
        'freezePreparedController',
        'verifyPreparedController',
      ].map((name) => [
        name,
        async () => {
          events.push(name);
        },
      ]),
    );
    return { events, target, inputs, effects };
  }
  it('compiles authentication helper before freezing artifact inventory', async () => {
    const f = fixture();
    await createOfflineRecoveryPreparation(f.effects).prepare(f.inputs);
    expect(f.events.indexOf('compileOperatorHelper')).toBeLessThan(
      f.events.indexOf('freezePreparedController'),
    );
    expect(f.events.filter((e) => e === 'assertSourceAccepted')).toHaveLength(3);
    expect(f.events.filter((e) => e === 'qualifyDependencies')).toHaveLength(2);
  });
  it('leaves candidate unqualified when accepted main advances during compilation', async () => {
    const f = fixture();
    let n = 0;
    f.effects.assertSourceAccepted = async () => {
      if (++n === 3) throw Error('advanced');
    };
    await expect(createOfflineRecoveryPreparation(f.effects).prepare(f.inputs)).rejects.toThrow(
      'advanced',
    );
    expect(f.events).not.toContain('freezePreparedController');
  });
  it('refuses an existing destination before cloning or building', async () => {
    const f = fixture();
    f.effects.assertDestinationAbsent = async () => {
      throw Error('preserve');
    };
    await expect(createOfflineRecoveryPreparation(f.effects).prepare(f.inputs)).rejects.toThrow(
      'preserve',
    );
    expect(f.events).not.toContain('cloneAcceptedSource');
  });
  it('refuses malformed pins and repeated preparation on one controller', async () => {
    const f = fixture();
    const controller = createOfflineRecoveryPreparation(f.effects);
    await expect(controller.prepare({ ...f.inputs, target: 'main' })).rejects.toThrow();
    expect(f.events).toEqual([]);
    await controller.prepare(f.inputs);
    await expect(controller.prepare(f.inputs)).rejects.toThrow();
  });
});

it('allows the generated prepared receipt only during canonical final verification', () => {
  expect(() => assertOfflinePreparationStatus('?? staging-release.json', true)).not.toThrow();
  expect(() => assertOfflinePreparationStatus('?? staging-release.json')).toThrow();
  for (const status of [
    '?? staging-release.json\n?? scripts/override.mjs',
    ' M staging-release.json',
    '?? sub/staging-release.json',
    '?? stage.json',
  ])
    expect(() => assertOfflinePreparationStatus(status, true)).toThrow();
});

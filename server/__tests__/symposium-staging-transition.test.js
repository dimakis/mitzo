import { describe, it, expect } from 'vitest';
import {
  assertOrdinaryOwner,
  assertAcceptedTransition,
  transitionStage,
  routeStage,
} from '../../scripts/lib/symposium-staging-transition.mjs';
const source = 'a'.repeat(40),
  target = 'b'.repeat(40),
  root = '/private/stage';
const original = {
  sourceCommit: source,
  release: root + '/releases/' + source.slice(0, 12),
  pid: 42,
  birth: 'Mon Oct 5 10:00:00 2026',
  cwd: root + '/releases/' + source.slice(0, 12),
};
const runtime = { ...original, jobPid: 42, portPids: [42], protectedPids: [] };
describe('initial canonical staging transition', () => {
  it('requires original ordinary PID, birth, directory and exclusive listener', () => {
    expect(() => assertOrdinaryOwner(original, runtime)).not.toThrow();
    for (const changed of [
      { pid: 43 },
      { birth: 'reused' },
      { cwd: '/production' },
      { jobPid: 43 },
      { portPids: [43] },
      { portPids: [42, 43] },
      { protectedPids: [42] },
    ])
      expect(() => assertOrdinaryOwner(original, { ...runtime, ...changed })).toThrow();
  });
  it('requires exact accepted main and identical selected controller files', () => {
    expect(() => assertAcceptedTransition(target, target, true)).not.toThrow();
    expect(() => assertAcceptedTransition(target, source, true)).toThrow();
    expect(() => assertAcceptedTransition(target, target, false)).toThrow();
  });
  it('routes owned check/drain only and never delegates ordinary mutation', () => {
    expect(routeStage(null, 'check')).toBe('ordinary');
    expect(routeStage({ mode: 'owned-custodian' }, 'check')).toBe('owned');
    expect(routeStage({ mode: 'owned-custodian' }, 'drain')).toBe('owned');
    for (const command of ['prepare', 'deploy', 'restart'])
      expect(() => routeStage({ mode: 'owned-custodian' }, command)).toThrow();
    expect(() => routeStage({ mode: 'transitioning' }, 'check')).toThrow();
  });
  it('orders one original stop, preservation, activation and one start under one lock', async () => {
    const calls = [],
      effects = Object.fromEntries(
        ['lock', 'validate', 'stop', 'preserve', 'install', 'start', 'verify', 'unlock'].map(
          (name) => [name, async () => calls.push(name)],
        ),
      );
    effects.audit = async (state) => calls.push(state);
    await transitionStage(effects);
    expect(calls).toEqual([
      'lock',
      'validate',
      'stop',
      'preserve',
      'install',
      'start',
      'verify',
      'verified',
      'unlock',
    ]);
  });
  for (const failure of ['stop', 'preserve', 'install', 'start', 'verify'])
    it(`retains lock without rollback after uncertain ${failure}`, async () => {
      const calls = [],
        effects = Object.fromEntries(
          ['lock', 'validate', 'stop', 'preserve', 'install', 'start', 'verify', 'unlock'].map(
            (name) => [
              name,
              async () => {
                calls.push(name);
                if (name === failure) throw Error('uncertain');
              },
            ],
          ),
        );
      effects.audit = async (state) => calls.push(state);
      await expect(transitionStage(effects)).rejects.toThrow();
      expect(calls).not.toContain('unlock');
      expect(calls.at(-1)).toBe('uncertain');
      expect(calls.filter((x) => x === 'start').length).toBeLessThanOrEqual(1);
    });
  it('retains validation refusal evidence and releases unused lock', async () => {
    const calls = [],
      effects = {
        lock: async () => calls.push('lock'),
        validate: async () => {
          throw Error('refused');
        },
        audit: async (s) => calls.push(s),
        unlock: async () => calls.push('unlock'),
      };
    await expect(transitionStage(effects)).rejects.toThrow();
    expect(calls).toEqual(['lock', 'refused', 'unlock']);
  });
});

import { expect, it, vi } from 'vitest';
import { installContainedNativeRegistration } from '../../scripts/lib/staging-native-installation.mjs';
function fixture(fail) {
  const calls = [];
  const names = [
    'preflight',
    'acquireOriginalGuard',
    'verifyOriginalOrdinary',
    'stopOriginalOrdinary',
    'verifyOriginalStopped',
    'preserveOrdinaryInputs',
    'installStoppedNativeRegistration',
    'verifyStoppedNativeRegistration',
    'recordCompletedInstallation',
    'releaseOwnInstallationGuard',
    'startOriginalNativeLauncherOnce',
    'observeOriginalNativeLauncher',
    'retainInstallationEvidence',
  ];
  return {
    calls,
    effects: Object.fromEntries(
      names.map((name) => [
        name,
        vi.fn(async () => {
          calls.push(name);
          if (name === fail) throw Error(name);
        }),
      ]),
    ),
  };
}
it('preflights before ordinary shutdown and releases only parent guard before independent one-shot native actor', async () => {
  const f = fixture();
  await installContainedNativeRegistration(f.effects);
  expect(f.calls).toEqual([
    'preflight',
    'acquireOriginalGuard',
    'verifyOriginalOrdinary',
    'stopOriginalOrdinary',
    'verifyOriginalStopped',
    'preserveOrdinaryInputs',
    'installStoppedNativeRegistration',
    'verifyStoppedNativeRegistration',
    'recordCompletedInstallation',
    'releaseOwnInstallationGuard',
    'startOriginalNativeLauncherOnce',
    'observeOriginalNativeLauncher',
  ]);
});
it('refuses missing native source before guard/stop and preserves any attempted shutdown without retry or rollback', async () => {
  const preflight = fixture('preflight');
  await expect(installContainedNativeRegistration(preflight.effects)).rejects.toThrow('preflight');
  expect(preflight.calls).toEqual(['preflight']);
  const uncertain = fixture('verifyOriginalStopped');
  await expect(installContainedNativeRegistration(uncertain.effects)).rejects.toThrow(
    'verifyOriginalStopped',
  );
  expect(uncertain.calls.at(-1)).toBe('retainInstallationEvidence');
  expect(uncertain.effects.releaseOwnInstallationGuard).not.toHaveBeenCalled();
  expect(uncertain.effects.startOriginalNativeLauncherOnce).not.toHaveBeenCalled();
});

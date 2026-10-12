import { expect, it, vi } from 'vitest';
import { runSymposiumCustodian } from '../symposium-custodian-main.js';
it('refuses unimplemented native feature authority before host/bootstrap effects instead of ignoring it', async () => {
  const assertOriginalOwnerCurrent = vi.fn();
  const assertFreshEnrollmentCurrent = vi.fn();
  await expect(
    runSymposiumCustodian({
      stagingFeatureBootstrap: {
        sourceCommit: 'a'.repeat(40),
        sourceRoot: '/offline/source',
        fixtureRoot: '/offline/fixture',
        assertOriginalOwnerCurrent,
        assertFreshEnrollmentCurrent,
      },
    }),
  ).rejects.toThrow('not implemented');
  expect(assertOriginalOwnerCurrent).not.toHaveBeenCalled();
  expect(assertFreshEnrollmentCurrent).not.toHaveBeenCalled();
});
it('refuses non-callable awaited source/owner fence before allocating an owner', async () => {
  await expect(runSymposiumCustodian({ beforeControllerReady: true as never })).rejects.toThrow(
    'fence',
  );
  await expect(runSymposiumCustodian({ stagingFeatureBootstrap: true as never })).rejects.toThrow(
    'capabilities',
  );
});

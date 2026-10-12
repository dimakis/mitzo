import { expect, it, vi } from 'vitest';
import { runSymposiumCustodian } from '../symposium-custodian-main.js';
it('requires the actual awaited readiness fence before using any native feature capability', async () => {
  const assertOriginalOwnerCurrent = vi.fn();
  const observeResources = vi.fn();
  await expect(
    runSymposiumCustodian({
      stagingFeatureBootstrap: {
        sourceCommit: 'a'.repeat(40),
        sourceRoot: '/offline/source',
        fixtureRoot: '/offline/fixture',
        assertOriginalOwnerCurrent,
        observeResources,
      },
    }),
  ).rejects.toThrow('capabilities');
  expect(assertOriginalOwnerCurrent).not.toHaveBeenCalled();
  expect(observeResources).not.toHaveBeenCalled();
});
it('checks actual original source ownership before importing app stores or provisioning a host', async () => {
  const observeResources = vi.fn();
  await expect(
    runSymposiumCustodian({
      beforeControllerReady: async () => {},
      stagingFeatureBootstrap: {
        sourceCommit: 'a'.repeat(40),
        sourceRoot: '/offline/source',
        fixtureRoot: '/offline/fixture',
        assertOriginalOwnerCurrent: () => {
          throw Error('actual source guard refused');
        },
        observeResources,
      },
    }),
  ).rejects.toThrow('actual source guard refused');
  expect(observeResources).not.toHaveBeenCalled();
});
it('rejects serialized retirement acknowledgement before any host effect', async () => {
  await expect(runSymposiumCustodian({ beforeRetirementReceipt: true as never })).rejects.toThrow(
    'capability',
  );
});
it('rejects a serialized original custodian lifetime callback before any host effect', async () => {
  await expect(
    runSymposiumCustodian({ observeOriginalCustodianLifetime: true as never }),
  ).rejects.toThrow('lifetime observer');
});
it('refuses non-callable awaited source/owner fence before allocating an owner', async () => {
  await expect(runSymposiumCustodian({ beforeControllerReady: true as never })).rejects.toThrow(
    'fence',
  );
  await expect(runSymposiumCustodian({ stagingFeatureBootstrap: true as never })).rejects.toThrow(
    'capabilities',
  );
});

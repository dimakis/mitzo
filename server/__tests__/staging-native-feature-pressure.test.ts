import { afterEach, expect, it, vi } from 'vitest';
const model = vi.hoisted(() => ({ current: vi.fn(), cleanup: vi.fn(), describe: vi.fn() }));
vi.mock('../staging-native-model-authority.js', () => ({
  captureQualifiedStagingNativeModelAuthority: () => ({
    plan: async () => {
      await model.describe();
      return {
        revision: '9'.repeat(64),
        chargedAccount: 'authenticated-stage-account',
        selectedModel: 'gpt-6-luna',
        modelApprovalId: null,
        assertCurrent: model.current,
        assertOriginalCleanupCurrent: model.cleanup,
      };
    },
  }),
}));
import { AccountProfiles } from '../account-profiles.js';
import { StagingNativeFeatureOwner } from '../staging-native-feature-owner.js';
import type { OwnedSymposiumGateway } from '../symposium-owned-gateway.js';
afterEach(() => {
  vi.restoreAllMocks();
  model.describe.mockReset();
});
it('preserves known original cleanup at pressure while refusing new admission and lost original ownership', async () => {
  const sourceCommit = 'a'.repeat(40);
  let pressure = false,
    owner = true,
    temporalExpired = false,
    queueCurrent = true;
  let retainedCleanup: (() => void) | undefined;
  const clock = vi.spyOn(Date, 'now');
  model.current.mockImplementation(() => {
    if (temporalExpired) throw Error('inference/catalog expired');
  });
  const current = () => {
    if (!owner) throw Error('original owner lost');
  };
  const profiles = new AccountProfiles([
    {
      id: 'stage-api',
      label: 'Stage API',
      provider: 'openai',
      credentialRef: { provider: 'keychain', service: 'synthetic-only', account: 'stage' },
      sandboxProvider: 'fresh',
      sandboxProviderId: 'fresh',
      models: [{ id: 'gpt-6-luna', label: 'Luna' }],
    },
  ]);
  const feature = new StagingNativeFeatureOwner({
    bootstrap: {
      sourceCommit,
      sourceRoot: '/isolated/source',
      fixtureRoot: '/isolated/fixture',
      assertOriginalOwnerCurrent: current,
      observeResources: () => {
        if (pressure) throw Error('new resource admission refused');
        return {
          aggregateGiB: 1,
          growthGiB: 0,
          diskFreeGiB: 100,
          vmMemoryMiB: 4096,
          vmCpus: 2,
          allocationUUID: 'isolated',
          planSha256: 'b'.repeat(64),
          bootUUID: 'boot',
          supervisorPid: 100,
          vfkitPid: 101,
          observationSha256: 'c'.repeat(64),
          nativeRetirementClaim: false,
        };
      },
    },
    gateway: { verifyCustody: current } as unknown as OwnedSymposiumGateway,
    ownerInstance: 'original',
    currentProfiles: () => profiles,
    captureEnrollment: (profile, selected) => ({
      binding: profiles.resolve(profile, selected),
      selectedModel: selected,
      chargedAccount: 'authenticated-stage-account',
      assertCurrent: () => {
        current();
        if (temporalExpired) throw Error('catalog expired');
      },
      assertOriginalCleanupCurrent: current,
    }),
    assertOriginalOwnerCurrent: current,
    assertReservation: () => {
      current();
      if (!queueCurrent) throw Error('original queue expired or quarantined');
    },
    execute: async (input) => {
      retainedCleanup = input.assertCleanupCurrent;
      pressure = true;
      expect(() => input.assertCurrent()).toThrow('resource admission');
      expect(() => input.assertCleanupCurrent()).not.toThrow();
      owner = false;
      expect(() => input.assertCleanupCurrent()).toThrow('original owner lost');
      owner = true;
      input.assertCleanupCurrent();
      temporalExpired = true;
      clock.mockReturnValue(input.deadlineAt + 1);
      expect(() => input.assertCurrent()).toThrow('deadline');
      expect(() => input.assertCleanupCurrent()).not.toThrow();
      expect(model.cleanup).toHaveBeenCalled();
      queueCurrent = false;
      expect(() => input.assertCleanupCurrent()).toThrow('queue expired');
      queueCurrent = true;
      return {
        evidence: { synthetic: true },
        retirement: { syntheticOriginalCleanup: true },
        modelRequests: {
          version: 1,
          chargedAccount: 'authenticated-stage-account',
          selectedModel: 'gpt-6-luna',
          claimToken: 'original',
          sandboxId: 'original',
          requestCount: 1,
          requestsSha256: 'd'.repeat(64),
          modelPlanRevision: '9'.repeat(64),
          policyRevision: 'e'.repeat(64),
          revokedAt: Date.now(),
        },
      };
    },
  });
  const enrollment = feature.enrollment('stage-api');
  const proposal = await feature.plan(
    {
      version: 2,
      id: 'request',
      pr: 1,
      taskId: 'task',
      acceptedCommit: sourceCommit,
      suite: 'profile-tools-v1',
      ...enrollment,
    },
    sourceCommit,
  );
  const result = await feature.run(
    proposal.plan,
    { epoch: 1, requestId: 'request', owner: 'owner', nonce: 'nonce' },
    current,
  );
  expect(result.cleanupConfirmed).toBe(true);
  expect(() => retainedCleanup!()).toThrow('closed');
  expect(() => feature.enrollment('stage-api')).toThrow('resource admission');
  clock.mockRestore();
  model.current.mockReset();
  model.cleanup.mockReset();
});
it.each(['enrollment-after-await', 'different-provider-account'] as const)(
  'refuses %s before recording a native plan or dispatching fixtures',
  async (drift) => {
    const sourceCommit = 'a'.repeat(40);
    let chargedAccount =
      drift === 'enrollment-after-await'
        ? 'authenticated-stage-account'
        : 'different-authenticated-account';
    const current = vi.fn();
    const profiles = new AccountProfiles([
      {
        id: 'stage-api',
        label: 'Stage API',
        provider: 'openai',
        credentialRef: { provider: 'keychain', service: 'synthetic-only', account: 'stage' },
        sandboxProvider: 'fresh',
        sandboxProviderId: 'fresh',
        models: [{ id: 'gpt-6-luna', label: 'Luna' }],
      },
    ]);
    const execute = vi.fn();
    const feature = new StagingNativeFeatureOwner({
      bootstrap: {
        sourceCommit,
        sourceRoot: '/isolated/source',
        fixtureRoot: '/isolated/fixture',
        assertOriginalOwnerCurrent: current,
        observeResources: () => ({
          aggregateGiB: 1,
          growthGiB: 0,
          diskFreeGiB: 100,
          vmMemoryMiB: 4096,
          vmCpus: 2,
          allocationUUID: 'isolated',
          planSha256: 'b'.repeat(64),
          bootUUID: 'boot',
          supervisorPid: 100,
          vfkitPid: 101,
          observationSha256: 'c'.repeat(64),
          nativeRetirementClaim: false,
        }),
      },
      gateway: { verifyCustody: current } as unknown as OwnedSymposiumGateway,
      ownerInstance: 'original',
      currentProfiles: () => profiles,
      captureEnrollment: (profile, selected) => ({
        binding: profiles.resolve(profile, selected),
        selectedModel: selected,
        chargedAccount,
        assertCurrent: current,
        assertOriginalCleanupCurrent: current,
      }),
      assertOriginalOwnerCurrent: current,
      assertReservation: current,
      execute,
    });
    const enrollment = feature.enrollment('stage-api');
    model.describe.mockImplementationOnce(async () => {
      await Promise.resolve();
      if (drift === 'enrollment-after-await') chargedAccount = 'different-authenticated-account';
    });
    await expect(
      feature.plan(
        {
          version: 2,
          id: 'request',
          pr: 1,
          taskId: 'task',
          acceptedCommit: sourceCommit,
          suite: 'profile-tools-v1',
          ...enrollment,
        },
        sourceCommit,
      ),
    ).rejects.toThrow(
      drift === 'enrollment-after-await' ? 'source/enrollment changed' : 'charged account differs',
    );
    expect(execute).not.toHaveBeenCalled();
  },
);

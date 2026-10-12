import { describe, expect, it, vi } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
import { StagingNativeFeatureOwner } from '../staging-native-feature-owner.js';
import type { OwnedSymposiumGateway } from '../symposium-owned-gateway.js';
const sourceCommit = 'a'.repeat(40);
function fixture() {
  const profiles = new AccountProfiles([
    {
      id: 'stage-api',
      label: 'Stage API',
      provider: 'openai',
      credentialRef: { provider: 'keychain', service: 'isolated-test', account: 'stage' },
      sandboxProvider: 'fresh',
      sandboxProviderId: 'fresh-object',
      models: [{ id: 'gpt-6-luna', label: 'Luna' }],
    },
  ]);
  const current = vi.fn(),
    execute = vi.fn();
  const observeResources = vi.fn(() => ({
    aggregateGiB: 1,
    growthGiB: 0,
    diskFreeGiB: 100,
    vmMemoryMiB: 4096 as const,
    vmCpus: 2 as const,
    allocationUUID: 'allocation',
    planSha256: 'b'.repeat(64),
    bootUUID: 'boot',
    supervisorPid: 100,
    vfkitPid: 101,
    observationSha256: 'c'.repeat(64),
    nativeRetirementClaim: false as const,
  }));
  const owner = new StagingNativeFeatureOwner({
    bootstrap: {
      sourceCommit,
      sourceRoot: '/isolated/source',
      fixtureRoot: '/isolated/fixture',
      assertOriginalOwnerCurrent: current,
      observeResources,
    },
    gateway: { verifyCustody: current } as unknown as OwnedSymposiumGateway,
    ownerInstance: 'original-owner',
    currentProfiles: () => profiles,
    captureEnrollment: (profile, model) => ({
      binding: profiles.resolve(profile, model),
      selectedModel: model,
      chargedAccount: profile,
      assertCurrent: current,
    }),
    assertOriginalOwnerCurrent: current,
    assertReservation: vi.fn(),
    execute,
  });
  return { owner, current, execute, observeResources };
}
describe('concrete conditional native feature owner', () => {
  it('refuses the missing actual gateway model authority before any fixture or native dispatch', () => {
    const f = fixture(),
      enrollment = f.owner.enrollment('stage-api');
    expect(() =>
      f.owner.plan(
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
    ).toThrow(/HTTP account\/model\/auxiliary\/max-two-request enforcement is not qualified/);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('retains actual original resource callback and source/owner identity, with no JSON capacity input', () => {
    const f = fixture();
    expect(f.owner.resources()).toMatchObject({
      sourceCommit,
      ownerInstance: 'original-owner',
      resources: { vmMemoryMiB: 4096, vmCpus: 2, nativeRetirementClaim: false },
    });
    expect(f.observeResources).toHaveBeenCalled();
    f.current.mockImplementation(() => {
      throw Error('actual owner lost');
    });
    expect(() => f.owner.resources()).toThrow(/owner lost/);
    expect(() => f.owner.enrollment('stage-api')).toThrow(/owner lost/);
  });
  it('does not derive run authority from model/profile/result JSON or a caller cleanup flag', async () => {
    const f = fixture();
    await expect(
      f.owner.run({ selectedModel: 'gpt-6-luna', cleanupConfirmed: true }, {}),
    ).rejects.toThrow(/authenticated custodian/);
    expect(f.execute).not.toHaveBeenCalled();
  });
});

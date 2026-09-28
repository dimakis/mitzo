import { describe, expect, it, vi } from 'vitest';
import { assertOwnedSealedReaderCurrent } from '../symposium-owned-reader-reference.js';

const h = 'a'.repeat(64);
const ref = {
  version: 1 as const,
  kind: 'sealed_reader' as const,
  readerAdmissionId: 'reader-1',
  artifactGenerationId: 'generation-1',
  sealFenceId: 'fence-1',
  bindingDigest: h,
};
const binding = {
  sessionId: 'session-1',
  seatId: 'reviewer',
  workspaceId: 'workspace',
  custodyDigest: h,
  volumeName: 'volume',
  artifactGenerationId: 'generation-1',
  readerAdmissionId: 'reader-1',
};
const receipt = { leaseTokenHash: h, leaseRevision: 'lease-1', access: 'reviewer' as const };
const lease = {
  request: {
    readerAdmissionId: 'reader-1',
    sessionId: 'session-1',
    seatId: 'reviewer',
    workspaceId: 'workspace',
    volumeName: 'volume',
    volumeGeneration: 'generation-1',
    access: 'reviewer',
  },
  tokenHash: h,
  revision: 'lease-1',
};
const dependencies = () => ({
  store: {
    assertSymposiumSealedReaderAdmissionCurrent: vi.fn(() => binding),
    getSymposiumSealedReaderAdmission: vi.fn(() => ({ binding, receipt })),
  },
  leaseHost: { sealLeaseIdentities: vi.fn(() => [lease]) },
  workspace: 'workspace',
  custodyDigest: h,
  assertAuthority: vi.fn(() => true as const),
});
describe('owned sealed reader final proof', () => {
  it('requires matching current EventStore, physical lease and current policy authority', () => {
    const deps = dependencies();
    expect(() => assertOwnedSealedReaderCurrent(deps as never, 'session-1', ref)).not.toThrow();
    expect(deps.assertAuthority).toHaveBeenCalledWith(binding);
    expect(() =>
      assertOwnedSealedReaderCurrent(
        {
          ...deps,
          leaseHost: {
            sealLeaseIdentities: () => [
              { ...lease, request: { ...lease.request, access: 'writer' } },
            ],
          },
        } as never,
        'session-1',
        ref,
      ),
    ).toThrow(/read-only/i);
    expect(() =>
      assertOwnedSealedReaderCurrent(
        { ...deps, assertAuthority: () => false as never } as never,
        'session-1',
        ref,
      ),
    ).toThrow(/policy/i);
    expect(() =>
      assertOwnedSealedReaderCurrent(
        {
          ...deps,
          store: {
            ...deps.store,
            getSymposiumSealedReaderAdmission: () => ({
              ...deps.store.getSymposiumSealedReaderAdmission(),
              receipt: { ...receipt, leaseTokenHash: 'b'.repeat(64) },
            }),
          },
        } as never,
        'session-1',
        ref,
      ),
    ).toThrow(/lease/i);
  });
});

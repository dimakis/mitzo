import { expect, it } from 'vitest';
import * as owned from '../symposium-owned-runtime-contract.js';
import { reviewedStagingOwnedBuild } from '../symposium-staging-runtime-contract.js';
// @ts-expect-error Production JavaScript helper has no declaration; exercise the actual proposal composer.
import { createOwnedRoutingProposal } from '../../scripts/lib/owned-stage-routing-proposal.mjs';

const gateway = (build: {
  cliSha256: string;
  gatewaySha256: string;
  image: string;
  sandboxRuntimeImage: string;
  supervisorImage: string;
}) => ({
  cliSha256: build.cliSha256,
  executableSha256: build.gatewaySha256,
  workloadImage: build.image,
  sandboxRuntimeImage: build.sandboxRuntimeImage,
  supervisorImage: build.supervisorImage,
});
it('retains the exact historical routing-v1 record and image-only default', () => {
  const old = owned.SOURCE_QUALIFIED_SYMPOSIUM_ROUTING_BUILD;
  expect(old.cliSha256).toBe('a66f3eb90cef5d39073800f4f287cbe0dd137d754faeac218db52325a713e836');
  expect(old.supervisorImage).toBe(
    'sha256:602585a9a550d5c8650bb10f2c80002b2d31e56fbef27f799c50d21ad26a6a89',
  );
  expect(reviewedStagingOwnedBuild(gateway(old))).toBe(old);
  expect(owned.reviewedSymposiumOwnedBuild(old.image)).toBe(
    owned.reviewedSymposiumOwnedRuntime(old.image).build,
  );
});
it('requires an explicit v2 selector and exact additive pins while preserving workload and gateway', () => {
  const next = owned.SOURCE_QUALIFIED_SYMPOSIUM_CONNECT_PREFACE_BUILD,
    old = owned.SOURCE_QUALIFIED_SYMPOSIUM_ROUTING_BUILD;
  expect(next.cliSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(next.supervisorImage).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(next.cliSha256).not.toBe(old.cliSha256);
  expect(next.supervisorImage).not.toBe(old.supervisorImage);
  for (const key of [
    'gatewayVersion',
    'gatewaySha256',
    'image',
    'imageDigest',
    'sandboxRuntimeImage',
    'nativeArtifacts',
  ] as const)
    expect(next[key]).toEqual(old[key]);
  expect(owned.reviewedSymposiumOwnedBuild(next.image, 'local-854b-routing-v2')).toBe(next);
  expect(owned.reviewedSymposiumRoutingDiagnosticBuild(next.image, 'local-854b-routing-v2')).toBe(
    next,
  );
  expect(reviewedStagingOwnedBuild(gateway(next))).toBe(next);
  expect(() =>
    owned.reviewedSymposiumRoutingDiagnosticBuild(
      owned.REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build.image,
      'local-854b-routing-v2',
    ),
  ).toThrow();
});
it('refuses every missing, unknown or mixed v1/v2 tuple pin', () => {
  const next = owned.SOURCE_QUALIFIED_SYMPOSIUM_CONNECT_PREFACE_BUILD,
    old = owned.SOURCE_QUALIFIED_SYMPOSIUM_ROUTING_BUILD;
  for (const key of Object.keys(gateway(next))) {
    expect(() =>
      reviewedStagingOwnedBuild({ ...gateway(next), [key]: undefined } as never),
    ).toThrow();
    expect(() =>
      reviewedStagingOwnedBuild({ ...gateway(next), [key]: 'unknown' } as never),
    ).toThrow();
  }
  expect(() => reviewedStagingOwnedBuild({ ...gateway(next), cliSha256: old.cliSha256 })).toThrow();
  expect(() =>
    reviewedStagingOwnedBuild({ ...gateway(old), supervisorImage: next.supervisorImage }),
  ).toThrow();
});
it('composes v1 to v2 from the exact configured historical tuple with only three gateway changes', () => {
  const next = owned.SOURCE_QUALIFIED_SYMPOSIUM_CONNECT_PREFACE_BUILD,
    old = owned.SOURCE_QUALIFIED_SYMPOSIUM_ROUTING_BUILD;
  const device = { executable: '/private/device', sha256: 'a'.repeat(64) };
  const config = {
    gateway: {
      ...gateway(old),
      cliExecutable: '/private/v1',
      stateParent: '/private/state',
      tls: { key: '/private/key' },
    },
    personal: { accountId: 'original', deviceLoginExecutable: device },
    runtime: { policy: '/private/policy' },
  };
  const before = structuredClone(config),
    pin = { executable: '/private/v2', sha256: next.cliSha256 };
  const result = createOwnedRoutingProposal(
    config,
    device,
    pin,
    reviewedStagingOwnedBuild(config.gateway),
    next,
  );
  expect(result).toEqual({
    ...config,
    gateway: {
      ...config.gateway,
      cliExecutable: pin.executable,
      cliSha256: next.cliSha256,
      supervisorImage: next.supervisorImage,
    },
  });
  expect(config).toEqual(before);
  expect(() =>
    createOwnedRoutingProposal(
      config,
      device,
      pin,
      owned.reviewedSymposiumOwnedRuntime(old.image).build,
      next,
    ),
  ).toThrow();
});

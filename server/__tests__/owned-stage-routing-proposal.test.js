import { expect, it } from 'vitest';
import { createOwnedRoutingProposal } from '../../scripts/lib/owned-stage-routing-proposal.mjs';

// Synthetic hashes only; this pure composer receives the source-selected build.
const original = {
  image: 'sha256:' + '1'.repeat(64),
  cliSha256: '2'.repeat(64),
  gatewaySha256: '3'.repeat(64),
  sandboxRuntimeImage: 'sha256:' + '4'.repeat(64),
  supervisorImage: 'sha256:' + '5'.repeat(64),
};
const target = {
  ...original,
  cliSha256: '6'.repeat(64),
  supervisorImage: 'sha256:' + '7'.repeat(64),
};
const pin = { executable: '/private/canonical/openshell-routing', sha256: target.cliSha256 };
const device = { executable: '/private/canonical/codex', sha256: '8'.repeat(64) };
function config() {
  return {
    gateway: {
      cliExecutable: '/original-cli',
      cliSha256: original.cliSha256,
      executable: '/original-gateway',
      executableSha256: original.gatewaySha256,
      workloadImage: original.image,
      sandboxRuntimeImage: original.sandboxRuntimeImage,
      supervisorImage: original.supervisorImage,
      tls: { key: '/private/key' },
      network: 'original-network',
      stateParent: '/original-state',
    },
    personal: { accountId: 'original', workProfiles: [], deviceLoginExecutable: device },
    runtime: { policy: '/original-policy' },
    providerProfiles: [{ path: '/original-profile' }],
    extraRetainedConfiguration: { preserved: true },
  };
}
it('composes only exact CLI/supervisor/device changes, preserving all original state inputs', () => {
  const old = config(),
    before = structuredClone(old);
  const proposed = createOwnedRoutingProposal(old, device, pin, original, target);
  expect(old).toEqual(before);
  expect(proposed).toEqual({
    ...old,
    gateway: {
      ...old.gateway,
      cliExecutable: pin.executable,
      cliSha256: pin.sha256,
      supervisorImage: target.supervisorImage,
    },
    personal: { ...old.personal, deviceLoginExecutable: device },
  });
});
it.each([
  'cliSha256',
  'executableSha256',
  'workloadImage',
  'sandboxRuntimeImage',
  'supervisorImage',
])('refuses original %s drift rather than migrating another tuple', (field) => {
  const old = config();
  old.gateway[field] = 'unreviewed';
  expect(() => createOwnedRoutingProposal(old, device, pin, original, target)).toThrow();
});
it.each(['gatewaySha256', 'image', 'sandboxRuntimeImage'])(
  'refuses a target that changes unrelated %s',
  (field) => {
    expect(() =>
      createOwnedRoutingProposal(config(), device, pin, original, {
        ...target,
        [field]: 'unreviewed',
      }),
    ).toThrow();
  },
);
it('refuses a CLI hash mismatch, malformed supervisor identity or relative executable', () => {
  expect(() =>
    createOwnedRoutingProposal(
      config(),
      device,
      { ...pin, sha256: '9'.repeat(64) },
      original,
      target,
    ),
  ).toThrow();
  expect(() =>
    createOwnedRoutingProposal(
      config(),
      device,
      { ...pin, executable: 'relative' },
      original,
      target,
    ),
  ).toThrow();
  expect(() =>
    createOwnedRoutingProposal(config(), device, pin, original, {
      ...target,
      supervisorImage: 'latest',
    }),
  ).toThrow();
});

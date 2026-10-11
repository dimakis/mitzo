import { it, expect, vi } from 'vitest';
import { runOfflineRecovery } from '../../scripts/recover-staging-offline.mjs';
import { recoveryProposal } from './fixtures/staging-offline-plans.js';
const operation = '33333333-3333-4333-8333-333333333333';
it('prepares only a full source SHA and paired explicitly pinned dependencies', async () => {
  const prepare = vi.fn(async () => ({ prepared: true, started: false }));
  const args = [
    'prepare-release',
    '--commit',
    'a'.repeat(40),
    '--dependency-source',
    '/audited',
    '--expected-dependency-fingerprint',
    'b'.repeat(64),
  ];
  expect(await runOfflineRecovery(args, { prepare })).toMatchObject({
    prepared: true,
    started: false,
  });
  expect(prepare).toHaveBeenCalledWith({
    target: 'a'.repeat(40),
    dependencySource: '/audited',
    dependencyFingerprint: 'b'.repeat(64),
  });
  for (const invalid of [
    args.slice(0, -2),
    [...args, '--apply'],
    [...args, '--commit', 'c'.repeat(40)],
  ])
    expect(await runOfflineRecovery(invalid, { prepare })).toMatchObject({ status: 'blocked' });
  expect(prepare).toHaveBeenCalledTimes(1);
});
it('generates a combined plan while audit remains a native observation only', async () => {
  const proposal = recoveryProposal();
  const observe = vi.fn(async () => ({ status: 'proposal', ...proposal.containmentPlan }));
  const collectOrdinaryFacts = vi.fn(async () => proposal.ordinaryPlan.facts);
  const result = await runOfflineRecovery(['plan', '--operation', operation], {
    observe,
    collectOrdinaryFacts,
  });
  expect(result.sha256).toBe(proposal.sha256);
  expect(result.mode).toBe('contain_then_restore_ordinary');
  const audit = await runOfflineRecovery(['audit', '--operation', operation], {
    observe,
    collectOrdinaryFacts,
  });
  expect(audit.status).toBe('proposal');
  expect(collectOrdinaryFacts).toHaveBeenCalledTimes(1);
});
it('regenerates both proposals before calling the trusted live apply capability', async () => {
  const proposal = recoveryProposal();
  const apply = vi.fn(async () => ({ completed: true }));
  const deps = {
    readPlan: () => proposal,
    observe: async () => ({ status: 'proposal', ...proposal.containmentPlan }),
    collectOrdinaryFacts: async () => proposal.ordinaryPlan.facts,
    apply,
  };
  await runOfflineRecovery(
    ['apply', '--plan', '/private/plan.json', '--expected-plan', proposal.sha256],
    deps,
  );
  expect(apply).toHaveBeenCalledTimes(1);
  const drift = globalThis.structuredClone(proposal.ordinaryPlan.facts);
  drift.preservation[0].manifestSha256 = '0'.repeat(64);
  deps.collectOrdinaryFacts = async () => drift;
  await expect(
    runOfflineRecovery(
      ['apply', '--plan', '/private/plan.json', '--expected-plan', proposal.sha256],
      deps,
    ),
  ).rejects.toThrow();
  expect(apply).toHaveBeenCalledTimes(1);
});
it('never reaches live apply from copied authority flags or mismatched plan hashes', async () => {
  const proposal = recoveryProposal();
  const apply = vi.fn();
  await expect(
    runOfflineRecovery(
      ['apply', '--plan', '/private/plan.json', '--expected-plan', '0'.repeat(64)],
      { readPlan: () => proposal, apply },
    ),
  ).rejects.toThrow();
  expect(
    await runOfflineRecovery(
      [
        'apply',
        '--plan',
        '/private/plan.json',
        '--expected-plan',
        proposal.sha256,
        '--authenticated',
      ],
      { apply },
    ),
  ).toMatchObject({ status: 'blocked' });
  expect(apply).not.toHaveBeenCalled();
});

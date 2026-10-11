import { it, expect, vi } from 'vitest';
import { recoveryProposal } from './fixtures/staging-offline-plans.js';
import { executeOfflineRecovery } from '../../scripts/lib/staging-offline-execution.mjs';
function fixture() {
  const proposal = recoveryProposal();
  const events = [];
  const token = Object.freeze({});
  const lease = { assertCurrent: vi.fn(), close: vi.fn() };
  const authorizer = {
    authenticate: vi.fn(async (sha) => {
      events.push(['authenticate', sha]);
      return token;
    }),
    consume: vi.fn((authority, sha) => {
      expect(authority).toBe(token);
      expect(sha).toBe(proposal.sha256);
      return lease;
    }),
  };
  const contain = async (_plan, authority, phases) => {
    events.push(['contain']);
    const phase = phases.consumeContainment(authority, proposal.containmentPlan.sha256);
    phase.assertCurrent(proposal.containmentPlan.sha256);
    phase.close();
    return { disposition: 'contained_offline_native_cleanup_unconfirmed' };
  };
  const assertContained = vi.fn(async () => {
    events.push(['verify contained']);
  });
  const restore = async (_plan, authority, phases) => {
    const phase = await phases.consumeOrdinary(authority, proposal.ordinaryPlan.sha256);
    events.push(['restore']);
    phase.assertCurrent(proposal.ordinaryPlan.sha256);
    phase.close();
    return { mode: 'ordinary', sourceCommit: proposal.ordinaryPlan.facts.source.sourceCommit };
  };
  return { proposal, events, authorizer, lease, contain, restore, assertContained };
}
it('authenticates the combined proposal once and verifies containment before restoration', async () => {
  const f = fixture();
  const result = await executeOfflineRecovery(f);
  expect(f.events.map((event) => event[0])).toEqual([
    'authenticate',
    'contain',
    'verify contained',
    'restore',
  ]);
  expect(f.authorizer.authenticate).toHaveBeenCalledWith(f.proposal.sha256);
  expect(f.authorizer.consume).toHaveBeenCalledTimes(1);
  expect(f.lease.close).toHaveBeenCalledTimes(1);
  expect(result.ordinary.mode).toBe('ordinary');
});
it('never authenticates a modified proposal or unbound ordinary component', async () => {
  const f = fixture();
  f.proposal = { ...f.proposal, sha256: 'f'.repeat(64) };
  await expect(executeOfflineRecovery(f)).rejects.toThrow();
  expect(f.authorizer.authenticate).not.toHaveBeenCalled();
});
it('retains native uncertainty and never restores after containment failure', async () => {
  const f = fixture();
  f.contain = async (_plan, token, phases) => {
    phases.consumeContainment(token, f.proposal.containmentPlan.sha256);
    throw Error('physical uncertainty');
  };
  f.restore = vi.fn();
  await expect(executeOfflineRecovery(f)).rejects.toThrow('physical uncertainty');
  expect(f.restore).not.toHaveBeenCalled();
  expect(f.lease.close).toHaveBeenCalledTimes(1);
});
it('closes the original lease after failed post-containment verification', async () => {
  const f = fixture();
  f.assertContained.mockRejectedValue(Error('archive changed'));
  f.restore = vi.fn(async (_p, token, phases) => {
    await phases.consumeOrdinary(token, f.proposal.ordinaryPlan.sha256);
  });
  await expect(executeOfflineRecovery(f)).rejects.toThrow('archive changed');
  expect(f.lease.close).toHaveBeenCalledTimes(1);
  expect(f.events).not.toContainEqual(['restore']);
});

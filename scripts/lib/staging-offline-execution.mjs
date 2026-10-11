import {
  createOfflineRecoveryProposal,
  createOfflineRecoveryAuthority,
} from './staging-offline-ordinary-restore.mjs';
import { offlineContainmentDigest } from './staging-offline-containment-contract.mjs';
/** Original reviewed controller orchestration. Source/physical proposal regeneration
 * and frozen helper enrollment occur before calling this function. Component effects
 * are constructor capabilities, never deserialized from the proposal. */
export async function executeOfflineRecovery({
  proposal: selected,
  authorizer,
  contain,
  restore,
  assertContained,
}) {
  const proposal = createOfflineRecoveryProposal(selected);
  if (
    offlineContainmentDigest(proposal) !== offlineContainmentDigest(selected) ||
    ['authenticate', 'consume'].some((name) => typeof authorizer?.[name] !== 'function') ||
    [contain, restore, assertContained].some((value) => typeof value !== 'function')
  )
    throw Error('Exact combined proposal and original recovery capabilities required');
  const phases = createOfflineRecoveryAuthority({
    proposal,
    consumeAuthority: authorizer.consume,
    assertContainmentReady: assertContained,
  });
  try {
    const authority = await authorizer.authenticate(proposal.sha256);
    const containment = await contain(proposal.containmentPlan, authority, phases);
    const ordinary = await restore(proposal.ordinaryPlan, authority, phases);
    return Object.freeze({ version: 1, proposalSha256: proposal.sha256, containment, ordinary });
  } finally {
    phases.close();
  }
}

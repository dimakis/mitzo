import { createHash } from 'node:crypto';
import { runStagingHostCommand } from './staging-pipeline-host.mjs';
/** A dispatched OPEN request remains uncertain indefinitely. This read-only
 * GitHub reconciliation is the only terminal release after merge dispatch. */
export function reconcileStagingSourceMerge(store, pr, run = runStagingHostCommand) {
  const held = store.sourceMergeStatus();
  if (held.state === 'idle' || held.pr !== pr) return { state: 'not_held', pr };
  const token = store.sourceMergeToken(pr);
  const value = JSON.parse(
    run('gh', [
      'pr',
      'view',
      String(pr),
      '--repo',
      'dimakis/mitzo',
      '--json',
      'state,headRefOid,mergeCommit',
    ]),
  );
  if (value.headRefOid !== token.head)
    throw Error('Actual merged head differs from admission; retain source fence');
  if (value.state === 'OPEN')
    return { state: 'pending', reason: 'merge-outcome-unconfirmed', pr, head: token.head };
  if (value.state === 'CLOSED' && !value.mergeCommit) {
    store.reconcileClosedSourceMerge(token);
    return { state: 'closed_unmerged', pr, head: token.head };
  }
  const acceptedCommit = value.mergeCommit?.oid;
  if (value.state !== 'MERGED' || !/^[a-f0-9]{40}$/.test(acceptedCommit ?? ''))
    throw Error('Actual merge outcome unconfirmed; retain source fence');
  const ancestry = JSON.parse(
    run('gh', [
      'api',
      `repos/dimakis/mitzo/compare/${acceptedCommit}...main`,
      '--jq',
      '{status,base_commit:{sha:.base_commit.sha}}',
    ]),
  );
  if (
    !['ahead', 'identical'].includes(ancestry.status) ||
    ancestry.base_commit?.sha !== acceptedCommit
  )
    throw Error('Accepted merge ancestry unconfirmed; retain source fence');
  const taskId = `pr-dimakis-mitzo-${pr}`,
    suite = 'http-readiness';
  const id = createHash('sha256')
    .update(JSON.stringify([pr, taskId, acceptedCommit, suite]))
    .digest('hex');
  store.completeSourceMerge(token, { id, pr, taskId, acceptedCommit, suite });
  return { state: 'queued', requestId: id, pr, head: token.head, acceptedCommit, suite };
}

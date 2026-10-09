import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';

/** Verify only a fully completed metadata write, bound to its retained operation.
 * A partial migration cannot be resumed or rewritten through this verifier. */
export function verifyRetainedQualification({
  root,
  operation,
  auditSha256,
  lock,
  qualification: q,
  snapshot,
  priorBytes,
  currentBytes,
}) {
  const hash = (b) => createHash('sha256').update(b).digest('hex');
  const fail = () => {
    throw Error('Completed original qualification is not proven; retain its lock and evidence');
  };
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operation ?? '') ||
    !/^[a-f0-9]{64}$/.test(auditSha256 ?? '') ||
    lock.id !== operation ||
    lock.mode !== 'legacy-qualification' ||
    !/^[a-f0-9]{40}$/.test(lock.controller ?? '') ||
    q.controllerSource !== lock.controller ||
    q.archive !== join(root, 'service/requalifications', operation) ||
    q.auditSha256 !== auditSha256 ||
    hash(JSON.stringify(snapshot)) !== auditSha256 ||
    snapshot.version !== 1 ||
    lock.expected !== snapshot.sourceCommit ||
    hash(priorBytes) !== snapshot.originalReceiptSha256 ||
    hash(currentBytes) !== q.resultingReceiptSha256 ||
    JSON.stringify(Object.fromEntries(Object.keys(snapshot).map((k) => [k, q[k]]))) !==
      JSON.stringify(snapshot)
  )
    fail();
  const prior = JSON.parse(priorBytes),
    expected = { ...prior, dependencyFingerprint: snapshot.closureFingerprint };
  if (
    prior.sourceCommit !== snapshot.sourceCommit ||
    !/^[a-f0-9]{64}$/.test(snapshot.closureFingerprint ?? '') ||
    !Buffer.from(JSON.stringify(expected, null, 2) + '\n').equals(currentBytes)
  )
    fail();
  return prior;
}

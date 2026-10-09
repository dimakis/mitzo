import { join } from 'node:path';
import { privateJson } from './staging-files.mjs';
import { bytes, hash } from './staging-cold-audit.mjs';

const inputNames = [
  'owned-release.json',
  'staging-custodian.plist',
  'staging-operator.json',
  'empty-accounts.json',
];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Reconstruct the complete expected intent from the selected update and prepared bytes. */
export function createFreshActivationIntent(root, source, p, plan) {
  if (
    plan.releaseRoot !== source ||
    plan.sourceCommit !== p.target ||
    plan.acceptedMainBaseline !== p.target ||
    plan.configPath !== p.live.plan.configPath ||
    plan.configSha256 !== p.proposalSha256 ||
    hash(bytes(plan.configPath)) !== p.proposalSha256 ||
    hash(bytes(join(source, 'staging-release.json'))) !== p.controllerReceiptSha256 ||
    !same(privateJson(join(p.archive, 'plan.json')), p)
  )
    throw Error('Exact fresh activation target, configuration and controller required');
  const inputs = Object.fromEntries(
    inputNames.map((name) => [name, hash(bytes(join(root, 'symposium/service', name)))]),
  );
  return {
    version: 1,
    operation: p.operation,
    target: p.target,
    planSha256: hash(bytes(join(p.archive, 'plan.json'))),
    controllerReceiptSha256: p.controllerReceiptSha256,
    configSha256: p.proposalSha256,
    registrationSha256: hash(bytes(join(root, 'symposium/settings/staging-registration.json'))),
    inputs,
    plistSha256: inputs['staging-custodian.plist'],
  };
}

/** A recorded intent cannot relax its schema or substitute prepared launch inputs.
 * The operation lock pins both records; a start attempt is the entire intent. */
export function verifyFreshActivationBinding(root, source, p, plan, lock, options = {}) {
  const expected = createFreshActivationIntent(root, source, p, plan);
  const intentPath = join(p.archive, 'fresh-activation.json');
  const intent = privateJson(intentPath);
  if (
    !same(intent, expected) ||
    lock.planSha256 !== expected.planSha256 ||
    hash(bytes(intentPath)) !== lock.freshActivationSha256
  )
    throw Error('Complete fresh activation binding changed');
  if (options.started) {
    const attemptPath = join(p.archive, 'start-attempt.json');
    if (
      !same(privateJson(attemptPath), intent) ||
      hash(bytes(attemptPath)) !== lock.startAttemptSha256
    )
      throw Error('Original fresh start attempt binding changed');
  }
  if (
    options.registered &&
    hash(bytes(join(root, 'service/com.mitzo.staging.plist'))) !== intent.plistSha256
  )
    throw Error('Fresh canonical registration changed');
  return intent;
}

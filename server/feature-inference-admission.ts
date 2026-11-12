import { canonicalJson } from './connections/capabilities/input-validation.js';
import type { AdviserFeatureOwner } from './adviser-harness-runtime.js';

// Execution capacity belongs to the process owner, not a transient formatter.
// These entries represent live requests only, never retained history/authority.
const active = new Map<string, { accountId: string; lease: object }>();
const MAX_ACTIVE = 20;
const MAX_PER_ACCOUNT = 2;

export function acquireFeatureInference(
  owner: string | AdviserFeatureOwner,
  accountId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (typeof owner !== 'string') owner.assertCurrentSync?.();
  const key = canonicalJson(
    typeof owner === 'string'
      ? [owner]
      : [
          owner.authSessionId,
          owner.feature.kind === 'github-publication'
            ? { kind: owner.feature.kind, operationId: owner.feature.operationId }
            : owner.feature,
        ],
  );
  if (
    active.has(key) ||
    active.size >= MAX_ACTIVE ||
    [...active.values()].filter((entry) => entry.accountId === accountId).length >= MAX_PER_ACCOUNT
  )
    throw Error('Adviser is busy');
  const lease = {};
  active.set(key, { accountId, lease });
  return () => {
    if (active.get(key)?.lease === lease) active.delete(key);
  };
}

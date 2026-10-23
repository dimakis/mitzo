import type { CodexNativeExecutionPolicy } from './codex-native-execution-policy.js';
import { isDeepStrictEqual } from 'node:util';

/** Private host-internal admission action. Historical native call identities are
 * deliberately absent: this action is owned by the live selected policy and
 * operator after the original provider turn completed. It is a base read ceiling,
 * never a statement about sticky upstream grants or task write authorization. */
export interface PreparedRepositoryBarrierReadScope {
  readonly bindingRevision: string;
  readonly profileRevision: string;
  readonly policyRevision: string;
  readonly readableRoots: readonly string[];
  readonly workspaceRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly signal: AbortSignal;
  assertCurrentSync(): void;
  revalidate(): Promise<void>;
}
interface Owners {
  signal: AbortSignal;
  selectedPolicy(): CodexNativeExecutionPolicy;
  assertCurrentSync(): void;
  revalidate(): Promise<void>;
  assertNativeExecutionCurrent?(policy: CodexNativeExecutionPolicy, commandId: string): void;
}
function unavailable(): never {
  throw Error('Prepared repository barrier read authority unavailable');
}
function assertSync(result: unknown): void {
  if (result === undefined) return;
  void Promise.resolve(result).catch(() => {});
  unavailable();
}

/** Called only from the actual owned preclaim composition. The caller supplies
 * its current selected policy and current operator/lease/workspace fences; no
 * route accepts these functions or obtains a port from a descriptive receipt. */
export async function withPreparedRepositoryBarrierReadScope<T>(
  policy: CodexNativeExecutionPolicy | undefined,
  sourceCommandId: string,
  owners: Owners,
  action: (scope: PreparedRepositoryBarrierReadScope) => Promise<T>,
): Promise<T> {
  if (!policy || !sourceCommandId || !Object.isFrozen(policy)) unavailable();
  const roots = [policy.readableRoots, policy.workspaceRoots, policy.deniedRoots];
  if (roots.some((value) => !Object.isFrozen(value))) unavailable();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([owners.signal, lifetime.signal]);
  const originalCurrent = owners.assertCurrentSync;
  const originalNativeCurrent = owners.assertNativeExecutionCurrent;
  const originalSelected = owners.selectedPolicy;
  const originalRevalidate = owners.revalidate;
  let closed = false;
  const assertCurrentSync = () => {
    if (closed) unavailable();
    signal.throwIfAborted();
    if (
      owners.assertCurrentSync !== originalCurrent ||
      owners.assertNativeExecutionCurrent !== originalNativeCurrent ||
      owners.selectedPolicy !== originalSelected ||
      owners.revalidate !== originalRevalidate
    )
      unavailable();
    assertSync(originalCurrent.call(owners));
    const current = originalSelected.call(owners);
    if (!Object.isFrozen(current) || !isDeepStrictEqual(current, policy)) unavailable();
    assertSync(originalNativeCurrent?.call(owners, policy, sourceCommandId));
  };
  try {
    assertCurrentSync();
    return await action(
      Object.freeze({
        bindingRevision: policy.bindingRevision,
        profileRevision: policy.profileRevision,
        policyRevision: policy.policyRevision,
        readableRoots: Object.freeze([...policy.readableRoots]),
        workspaceRoots: Object.freeze([...policy.workspaceRoots]),
        deniedRoots: Object.freeze([...policy.deniedRoots]),
        signal,
        assertCurrentSync,
        async revalidate() {
          assertCurrentSync();
          const checked: unknown = await originalRevalidate.call(owners);
          if (checked !== undefined) unavailable();
          assertCurrentSync();
        },
      }),
    );
  } finally {
    closed = true;
    lifetime.abort(Error('Prepared repository barrier action ended'));
  }
}

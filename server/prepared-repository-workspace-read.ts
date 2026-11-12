import type {
  FrozenHostQualifiedWorkspaceReadOwner,
  FrozenHostCodexBootstrapLease,
} from './frozen-host-codex-bootstrap.js';
import type { CodexNativeExecutionPolicy } from './codex-native-execution-policy.js';
import { LocalRepositoryReadAccess } from './local-repository-read-access.js';
import { withPreparedRepositoryBarrierReadScope } from './prepared-repository-barrier-read.js';
import {
  capturePreparedRepositoryReader,
  preparedRepositoryValidationReadMs,
} from './local-repository-native-read.js';

/** Called inside the original lease's withQualifiedWorkspaceReadOwner action.
 * That owner verifies native account identity before entry and before returning
 * the private validation result. The native helper also verifies account identity
 * immediately before its physical read. Nested scratch/result boundaries check
 * operator, credential files, runtime, policy and custody through its synchronous
 * fence; they need no additional account/read RPC. No authorization result is
 * cached, and the reader cannot outlive this original lease action.
 */
export async function withPreparedRepositoryWorkspaceRead(
  owner: FrozenHostQualifiedWorkspaceReadOwner,
  policy: CodexNativeExecutionPolicy,
  commandId: string,
  owners: {
    selectedPolicy(): CodexNativeExecutionPolicy;
    assertCurrentSync?(): void;
    assertNativeExecutionCurrent?(policy: CodexNativeExecutionPolicy, commandId: string): void;
  },
  action: (access: LocalRepositoryReadAccess) => Promise<void>,
): Promise<void> {
  const current = owners.assertCurrentSync;
  const selected = owners.selectedPolicy;
  const native = owners.assertNativeExecutionCurrent;
  const assertCurrentSync = () => {
    owner.assertCurrentSync();
    if (
      owners.assertCurrentSync !== current ||
      owners.selectedPolicy !== selected ||
      owners.assertNativeExecutionCurrent !== native
    )
      throw Error('Prepared repository workspace owner changed');
    const checked: unknown = current ? Reflect.apply(current, owners, []) : undefined;
    if (checked !== undefined) throw Error('Prepared repository workspace owner unavailable');
  };
  await withPreparedRepositoryBarrierReadScope(
    policy,
    commandId,
    {
      signal: owner.signal,
      selectedPolicy: () => Reflect.apply(selected, owners, []),
      assertCurrentSync,
      revalidate: async () => assertCurrentSync(),
      assertNativeExecutionCurrent: native
        ? (policy, commandId) => Reflect.apply(native, owners, [policy, commandId])
        : undefined,
    },
    async (scope) => {
      const reader = await capturePreparedRepositoryReader(scope, {
        deadline: Date.now() + preparedRepositoryValidationReadMs,
        beforePhysicalRead: () => owner.revalidate(),
      });
      try {
        const checked: unknown = await action(new LocalRepositoryReadAccess(reader));
        if (checked !== undefined) throw Error('Prepared repository workspace read unavailable');
      } finally {
        await reader.dispose();
      }
      scope.assertCurrentSync();
    },
  );
}

/** Shared lease-bound topology read for cold resume and inspection-only recovery.
 * The original lease verifies account identity around the same physical action. */
export async function withPreparedRepositoryLeaseRead(
  currentLease: () => FrozenHostCodexBootstrapLease,
  signal: AbortSignal,
  commandId: string,
  policy: (owner: FrozenHostQualifiedWorkspaceReadOwner) => CodexNativeExecutionPolicy,
  action: (access: LocalRepositoryReadAccess) => Promise<void>,
): Promise<void> {
  const lease = currentLease();
  const withReadOwner = lease.withQualifiedWorkspaceReadOwner;
  if (!withReadOwner) throw Error('Original prepared workspace read owner unavailable');
  let completed = false;
  const result: unknown = await Reflect.apply(withReadOwner, lease, [
    signal,
    async (owner: FrozenHostQualifiedWorkspaceReadOwner) => {
      const selectedPolicy = () => policy(owner);
      await withPreparedRepositoryWorkspaceRead(
        owner,
        selectedPolicy(),
        commandId,
        { selectedPolicy },
        action,
      );
      completed = true;
    },
  ]);
  if (
    result !== undefined ||
    !completed ||
    lease !== currentLease() ||
    lease.withQualifiedWorkspaceReadOwner !== withReadOwner
  )
    throw Error('Prepared workspace read owner changed');
}

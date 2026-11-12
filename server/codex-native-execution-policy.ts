import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { MitzoMode } from '@mitzo/protocol';
import { isDeepStrictEqual } from 'node:util';
import { SessionRuntimeError } from './session-runtime-error.js';

/** Trusted selected execution policy, never a repository name, prompt or client
 * request. Configured scope is distinct from observed kernel enforcement. */
export interface CodexNativeExecutionPolicy {
  readonly version: 'native-mac-permissions-v1';
  readonly bindingRevision: string;
  readonly policyRevision: string;
  readonly profileRevision: string;
  readonly enforcement: 'configured';
  readonly scopeKind: 'base-profile';
  readonly grantState: 'upstream-owned';
  readonly temporaryAccess?: 'runtime';
  readonly profileVersion?: 'auto-network-v1';
  readonly cwd: string;
  readonly readableRoots: readonly string[];
  /** Admitted task writes; the named profile separately controls runtime scratch. */
  readonly writableRoots: readonly string[];
  readonly workspaceRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly writeProtectedRoots: readonly string[];
  readonly networkAccess: 'restricted' | 'enabled';
  readonly approvalPolicy: 'on-request';
  readonly permissions: 'mitzo-native-ask' | 'mitzo-native-agent' | 'mitzo-native-auto';
  readonly reviewer: 'user';
  readonly reviewerAvailability: 'unqualified';
}

function canonical(path: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw Error('Invalid native execution path');
  const full = resolve(path);
  try {
    return realpathSync(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(full);
    return parent === full ? full : join(canonical(parent), basename(full));
  }
}
const roots = (paths: readonly string[]) =>
  Object.freeze([...new Set(paths.map(canonical))].sort());
const contains = (root: string, path: string) =>
  root === '/' || path === root || path.startsWith(root + '/');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Pinned macOS emits absolute deny globs as final kernel deny rules. Exact
 * parent path entries alone can be overridden by a more-specific grant. */
const subtreeDenyGlob = (path: string) => `${path.replace(/[\\*?[\]{}]/g, '\\$&')}{,/**}`;

const NATIVE_TEMPORARY_PATHS = [':tmpdir', ':slash_tmp'] as const;

// Compare the canonical paths captured at admission. Re-resolving the old paths
// here could conceal a symlink replacement. Redundant final subtree denies do
// not change authority, even when discovered by another chat.
function protectionScope(paths: readonly string[]) {
  return [...new Set(paths)]
    .sort()
    .filter((path, _, all) => !all.some((parent) => parent !== path && contains(parent, path)));
}
function profileScope(policy: CodexNativeExecutionPolicy) {
  return {
    version: policy.version,
    bindingRevision: policy.bindingRevision,
    readableRoots: policy.readableRoots,
    deniedRoots: protectionScope(policy.deniedRoots),
    // Positive read entries can intersect more-specific implicit scratch writes.
    // Their apparent subtree redundancy is not proof of equivalent enforcement.
    writeProtectedRoots: policy.writeProtectedRoots,
    temporaryAccess: policy.temporaryAccess,
    profileVersion: policy.profileVersion,
  };
}
type NativePolicyField = keyof CodexNativeExecutionPolicy | 'owner' | 'profile';
export class NativeExecutionPolicyChangedError extends SessionRuntimeError {
  readonly changedFields: readonly NativePolicyField[];
  constructor(changedFields: readonly NativePolicyField[]) {
    super('native_policy_changed');
    this.changedFields = Object.freeze([...changedFields]);
  }
}
function assertComparableFingerprints(
  initial: CodexNativeExecutionPolicy,
  next: CodexNativeExecutionPolicy,
) {
  if (
    initial.profileRevision === next.profileRevision &&
    initial.policyRevision === next.policyRevision
  )
    return;
  for (const policy of [initial, next]) {
    const profile = codexNativeProfileRevision(policy);
    if (profile !== policy.profileRevision)
      throw new NativeExecutionPolicyChangedError(['profileRevision']);
    if (
      digest([profile, policy.cwd, policy.workspaceRoots, policy.permissions]) !==
      policy.policyRevision
    )
      throw new NativeExecutionPolicyChangedError(['policyRevision']);
  }
}
/** Hashes retain exact historical receipts. Current authority compares effective
 * protections as well, so redundant registry entries cannot retire other chats.
 * New, removed or relocated protections still require fresh owning admission. */
export function assertNativeExecutionCurrent(
  initial: CodexNativeExecutionPolicy,
  next: CodexNativeExecutionPolicy,
) {
  assertComparableFingerprints(initial, next);
  const scope = (policy: CodexNativeExecutionPolicy) => ({
    ...profileScope(policy),
    cwd: policy.cwd,
    workspaceRoots: policy.workspaceRoots,
    writableRoots: policy.writableRoots,
    permissions: policy.permissions,
    networkAccess: policy.networkAccess,
    approvalPolicy: policy.approvalPolicy,
    reviewer: policy.reviewer,
    reviewerAvailability: policy.reviewerAvailability,
    enforcement: policy.enforcement,
    scopeKind: policy.scopeKind,
    grantState: policy.grantState,
  });
  const before = scope(initial),
    after = scope(next);
  const changed = (Object.keys(before) as Array<keyof typeof before>).filter(
    (field) => !isDeepStrictEqual(before[field], after[field]),
  );
  if (changed.length) throw new NativeExecutionPolicyChangedError(changed);
}

/** Shared with retained-receipt validation; absent temporaryAccess is historical. */
export function codexNativeProfileRevision(
  policy: Pick<
    CodexNativeExecutionPolicy,
    | 'bindingRevision'
    | 'readableRoots'
    | 'deniedRoots'
    | 'writeProtectedRoots'
    | 'temporaryAccess'
    | 'profileVersion'
  >,
) {
  return digest([
    policy.bindingRevision,
    policy.readableRoots,
    policy.deniedRoots,
    policy.writeProtectedRoots,
    ...(policy.temporaryAccess === 'runtime' ? [NATIVE_TEMPORARY_PATHS] : []),
    ...(policy.profileVersion ? [policy.profileVersion] : []),
  ]);
}

export function codexNativeExecutionPolicy(input: {
  bindingRevision: string;
  mode: MitzoMode;
  cwd: string;
  readableRoots: readonly string[];
  writableRoots: readonly string[];
  deniedRoots: readonly string[];
  writeProtectedRoots?: readonly string[];
}): CodexNativeExecutionPolicy {
  if (!input.bindingRevision) throw Error('Native execution binding unavailable');
  const cwd = canonical(input.cwd);
  const readableRoots = roots(input.readableRoots);
  const workspaceRoots = roots(input.writableRoots);
  const deniedRoots = roots(input.deniedRoots);
  const writeProtectedRoots = roots(input.writeProtectedRoots ?? []);
  // Pinned positive-map parsing treats a trailing /** as its parent and has
  // no qualified literal encoding. Refuse rather than broaden authority.
  if ([...readableRoots, ...writeProtectedRoots].some((root) => /[\\*?[\]{}]/.test(root)))
    throw Error('Native positive filesystem path requires unsupported literal encoding');
  if (
    [...readableRoots, ...writeProtectedRoots].some((root) =>
      deniedRoots.some((denied) => contains(denied, root)),
    )
  )
    throw Error('Native read scope exposes protected storage');
  if (!deniedRoots.length || !readableRoots.length || !workspaceRoots.length)
    throw Error('Native execution scope unavailable');
  if (
    !workspaceRoots.some((root) => contains(root, cwd)) ||
    workspaceRoots.some((root) =>
      [...deniedRoots, ...writeProtectedRoots].some(
        (privateRoot) => contains(privateRoot, root) || contains(root, privateRoot),
      ),
    )
  )
    throw Error('Native workspace overlaps protected authority');
  // A task-only reader/adviser must not gain host-wide scratch visibility.
  const temporaryAccess = readableRoots.includes('/') ? ('runtime' as const) : undefined;
  const profileRevision = codexNativeProfileRevision({
    bindingRevision: input.bindingRevision,
    readableRoots,
    deniedRoots,
    writeProtectedRoots,
    ...(temporaryAccess ? { temporaryAccess } : {}),
    profileVersion: 'auto-network-v1',
  });
  const permissions = `mitzo-native-${input.mode}` as CodexNativeExecutionPolicy['permissions'];
  return Object.freeze({
    version: 'native-mac-permissions-v1',
    bindingRevision: input.bindingRevision,
    profileRevision,
    policyRevision: digest([profileRevision, cwd, workspaceRoots, permissions]),
    enforcement: 'configured',
    scopeKind: 'base-profile',
    grantState: 'upstream-owned',
    ...(temporaryAccess ? { temporaryAccess } : {}),
    profileVersion: 'auto-network-v1',
    cwd,
    readableRoots,
    writableRoots: input.mode === 'ask' ? Object.freeze([]) : workspaceRoots,
    workspaceRoots,
    deniedRoots,
    writeProtectedRoots,
    networkAccess: input.mode === 'auto' ? 'enabled' : 'restricted',
    approvalPolicy: 'on-request',
    permissions,
    // Pinned schema support alone does not qualify reviewer model availability,
    // billing or account routing. Human review remains the explicit fallback.
    reviewer: 'user',
    reviewerAvailability: 'unqualified',
  });
}

/** Every profile retains the same read/credential ceiling. Workspace symbols
 * materialize from the command owner's runtimeWorkspaceRoots on each turn. */
export function codexNativePermissionProfiles(policy: CodexNativeExecutionPolicy) {
  const filesystem = (workspaceAccess: 'read' | 'write') =>
    Object.fromEntries([
      ...policy.readableRoots.map((root) => [root, 'read']),
      // The native engine adds an implicit read-only .git carveout to a
      // workspace write rule. Explicitly scope Git writes to each admitted
      // root so normal add/commit/merge works without an unsandboxed escape.
      [
        ':workspace_roots',
        workspaceAccess === 'write' ? { '.': 'write', '.git': 'write' } : 'read',
      ],
      ...(policy.temporaryAccess === 'runtime'
        ? NATIVE_TEMPORARY_PATHS.map((root) => [root, workspaceAccess])
        : []),
      ...policy.writeProtectedRoots
        .filter((root) => policy.readableRoots.some((readable) => contains(readable, root)))
        .map((root) => [root, 'read']),
      ...policy.deniedRoots.flatMap((root) => [
        ...(/[\\*?[\]{}]/.test(root) ? [] : [[root, 'deny']]),
        [subtreeDenyGlob(root), 'deny'],
      ]),
    ]);
  return {
    default_permissions: policy.permissions,
    permissions: {
      'mitzo-native-ask': { filesystem: filesystem('read'), network: { enabled: false } },
      'mitzo-native-agent': { filesystem: filesystem('write'), network: { enabled: false } },
      'mitzo-native-auto': { filesystem: filesystem('write'), network: { enabled: true } },
    },
  };
}

/** Named profiles are installed at thread creation. A changed read/credential
 * ceiling requires fresh admission, rather than a turn using a stale profile. */
export function assertNativeExecutionRefresh(
  initial: CodexNativeExecutionPolicy,
  next: CodexNativeExecutionPolicy,
): void {
  assertComparableFingerprints(initial, next);
  if (!isDeepStrictEqual(profileScope(initial), profileScope(next)))
    throw new NativeExecutionPolicyChangedError(['profile']);
}

export function codexNativeExecutionParams(policy: CodexNativeExecutionPolicy) {
  return {
    cwd: policy.cwd,
    runtimeWorkspaceRoots: [...policy.workspaceRoots],
    permissions: policy.permissions,
    approvalPolicy: policy.approvalPolicy,
    approvalsReviewer: policy.reviewer,
  };
}

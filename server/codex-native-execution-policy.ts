import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { MitzoMode } from '@mitzo/protocol';

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
  readonly cwd: string;
  readonly readableRoots: readonly string[];
  /** Admitted task writes; the named profile separately controls runtime scratch. */
  readonly writableRoots: readonly string[];
  readonly workspaceRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly writeProtectedRoots: readonly string[];
  readonly networkAccess: 'restricted';
  readonly approvalPolicy: 'on-request';
  readonly permissions: 'mitzo-native-ask' | 'mitzo-native-agent';
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

/** Shared with retained-receipt validation; absent temporaryAccess is historical. */
export function codexNativeProfileRevision(
  policy: Pick<
    CodexNativeExecutionPolicy,
    'bindingRevision' | 'readableRoots' | 'deniedRoots' | 'writeProtectedRoots' | 'temporaryAccess'
  >,
) {
  return digest([
    policy.bindingRevision,
    policy.readableRoots,
    policy.deniedRoots,
    policy.writeProtectedRoots,
    ...(policy.temporaryAccess === 'runtime' ? [NATIVE_TEMPORARY_PATHS] : []),
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
  });
  const permissions = input.mode === 'ask' ? 'mitzo-native-ask' : 'mitzo-native-agent';
  return Object.freeze({
    version: 'native-mac-permissions-v1',
    bindingRevision: input.bindingRevision,
    profileRevision,
    policyRevision: digest([profileRevision, cwd, workspaceRoots, permissions]),
    enforcement: 'configured',
    scopeKind: 'base-profile',
    grantState: 'upstream-owned',
    ...(temporaryAccess ? { temporaryAccess } : {}),
    cwd,
    readableRoots,
    writableRoots: input.mode === 'ask' ? Object.freeze([]) : workspaceRoots,
    workspaceRoots,
    deniedRoots,
    writeProtectedRoots,
    networkAccess: 'restricted',
    approvalPolicy: 'on-request',
    permissions,
    // Pinned schema support alone does not qualify reviewer model availability,
    // billing or account routing. Human review remains the explicit fallback.
    reviewer: 'user',
    reviewerAvailability: 'unqualified',
  });
}

/** Both profiles retain the same read/credential ceiling. Workspace symbols
 * materialize from the command owner's runtimeWorkspaceRoots on each turn. */
export function codexNativePermissionProfiles(policy: CodexNativeExecutionPolicy) {
  const filesystem = (workspaceAccess: 'read' | 'write') =>
    Object.fromEntries([
      ...policy.readableRoots.map((root) => [root, 'read']),
      [':workspace_roots', workspaceAccess],
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
    },
  };
}

/** Named profiles are installed at thread creation. A changed read/credential
 * ceiling requires fresh admission, rather than a turn using a stale profile. */
export function assertNativeExecutionRefresh(
  initial: CodexNativeExecutionPolicy,
  next: CodexNativeExecutionPolicy,
): void {
  if (initial.profileRevision !== next.profileRevision)
    throw Error('Native execution policy changed; reopen through its owning admission');
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

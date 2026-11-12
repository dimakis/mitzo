import type { ManagedSession } from '@mitzo/harness';
import type { NativeApprovalRequest } from './codex-native-permission-protocol.js';
import { captureSessionCapability, containsCapabilityPath } from './session-capability-grants.js';
import { nativeCommandDirectoryScope } from './codex-native-grant-fence.js';
import { isDeepStrictEqual } from 'node:util';
import { isGwsShimCommand } from './gws-shell.js';

/** A single command's explicit network overlay. Permission-profile approvals
 * would grant turn/session authority upstream and cannot retain this fence. */
export function captureNativeDevelopmentGrant(
  session: ManagedSession,
  request: NativeApprovalRequest,
) {
  if (
    request.method !== 'item/commandExecution/requestApproval' ||
    request.params.kind !== 'command'
  )
    return;
  const profile = request.params.additionalPermissions;
  // The grant adds networking only. Filesystem expansion, opaque/unsandboxed
  // escalations and stdin consent still need their own exact approval.
  if (!profile || profile.fileSystem !== null || profile.network?.enabled !== true) return;
  const cwd = request.params.cwd;
  const roots = session.worktreePaths.size
    ? [...session.worktreePaths.values()].map((w) => w.path)
    : [session.cwd!];
  const root = cwd && roots.find((root) => containsCapabilityPath(root, cwd));
  if (!root || !cwd) return;
  const directory = nativeCommandDirectoryScope(cwd, root);
  if (!directory || directory[0]!.length < 3) return;
  const consent = captureSessionCapability(session, { kind: 'development', paths: [cwd] });
  if (!consent) return;
  return () => {
    consent();
    if (!isDeepStrictEqual(directory, nativeCommandDirectoryScope(cwd, root)))
      throw Error('Development command directory changed');
  };
}

/** A network-only escalation for one plain Mitzo gws client command. The client
 * can only reach the chat's broker, which owns the Google approval itself, so a
 * second shell prompt would duplicate consent without adding authority. */
export function isNativeGwsBrokerEscalation(request: NativeApprovalRequest): boolean {
  if (
    request.method !== 'item/commandExecution/requestApproval' ||
    request.params.kind !== 'command' ||
    request.params.networkApprovalContext
  )
    return false;
  const profile = request.params.additionalPermissions;
  return (
    !!profile &&
    profile.fileSystem === null &&
    profile.network?.enabled === true &&
    isGwsShimCommand(request.params.command)
  );
}

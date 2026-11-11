import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { NativeApprovalRequest } from './codex-native-permission-protocol.js';
import { nativeCommandDirectoryScope } from './codex-native-grant-fence.js';
import { githubReadCommandRepository } from '@mitzo/harness';

/** Retain an exact command or a recognized repository CLI read scope, never a
 * shell prefix or filesystem expansion. Each RPC still checks its owner and grant fence;
 * upstream receives an ordinary accept for that RPC, not a policy amendment. */
export function nativeCommandApprovalScope(
  request: NativeApprovalRequest,
  owner: {
    runtimeId: string;
    environmentId: string;
    policyRevision?: string;
    mode: string;
    cwd?: string;
    deniedRoots: readonly string[];
    writeProtectedRoots: readonly string[];
  },
): string | undefined {
  if (request.method !== 'item/commandExecution/requestApproval') return;
  const params = request.params;
  if (
    params.kind !== 'command' ||
    !params.command ||
    !params.cwd ||
    !isAbsolute(params.cwd) ||
    !owner.cwd ||
    params.approvalId ||
    params.networkApprovalContext ||
    params.additionalPermissions?.fileSystem
  )
    return;
  const directory = nativeCommandDirectoryScope(params.cwd, owner.cwd);
  if (!directory) return;
  const repository = githubReadCommandRepository(params.command);
  return `${repository ? 'native-github-read-v1' : 'native-command-v1'}:${createHash('sha256')
    .update(
      JSON.stringify([
        owner,
        directory,
        params.threadId,
        params.cwd,
        repository ?? params.command,
        params.additionalPermissions ?? null,
      ]),
    )
    .digest('hex')}`;
}

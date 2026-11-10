import { createHash } from 'node:crypto';
import { TASK_EXECUTION_INSTRUCTIONS } from './task-execution-definitions.js';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { MitzoMode, AccountBinding } from '@mitzo/protocol';
import type { ManagedSession } from './session-registry.js';
import { loadAccountProfiles } from './account-profiles.js';
import { privateCodexPathSnapshot } from './codex-private-path.js';
import {
  workspaceRuntimeNativeAuthorityPaths,
  workspaceRuntimeSelectorEntries,
} from './workspace-runtime-private-paths.js';
import { codexNativeExecutionPolicy } from './codex-native-execution-policy.js';

/** Reuses the admitted host tool owner's actual scope: Read is host-readable
 * except private roots; Bash omits a narrower readableRoots policy. An explicit
 * selected target read ceiling is retained rather than widened by Agent mode.
 * The callback is the existing measured account/workspace/operator owner. */
export function composeOwnedLocalNativeExecutionPolicy(input: {
  session: ManagedSession;
  binding: AccountBinding;
  readableRoots?: readonly string[];
  assertCurrentSync(): void;
}) {
  return composeOwnedLocalNativeExecutionPolicyForWorkspace(input, () => ({
    cwd: input.session.cwd!,
    mode: input.session.mode,
    workspaceRoots: input.session.worktreePaths.size
      ? [...input.session.worktreePaths.values()].map((entry) => entry.path)
      : [input.session.cwd!],
    authSessionId: input.session.ownedLocalAuthSessionId,
  }));
}

/** SAME selected-policy projection for the private qualified cold owner. The
 * capture callback belongs to the actual driver/current workspace authority;
 * these values alone confer neither read authority nor permission to dispatch. */
export function composeOwnedLocalNativeExecutionPolicyForWorkspace(
  input: { binding: AccountBinding; readableRoots?: readonly string[]; assertCurrentSync(): void },
  captureWorkspace: () => Readonly<{
    cwd: string;
    mode: MitzoMode;
    workspaceRoots: readonly string[];
    authSessionId?: string;
  }>,
  // Qualified inspection may retain the exact accepted command identity.
  // Current scope and owner authority are still recomputed and checked below.
  retainedBindingRevision?: string,
) {
  const originalCurrent = input.assertCurrentSync;
  const current = () => {
    if (input.assertCurrentSync !== originalCurrent)
      throw Error('Original native policy owner unavailable');
    const checked: unknown = Reflect.apply(originalCurrent, input, []);
    if (checked !== undefined) {
      void Promise.resolve(checked).catch(() => {});
      throw Error('Native policy owner must provide synchronous proof');
    }
    if (input.assertCurrentSync !== originalCurrent)
      throw Error('Original native policy owner unavailable');
  };
  current();
  const selection = captureWorkspace();
  if (!selection.cwd || !selection.workspaceRoots.length)
    throw Error('Native workspace unavailable');
  // One fresh complete snapshot for this composition only. Every invocation
  // reloads the actual profile roots and retained/configured private roots.
  const privatePaths = privateCodexPathSnapshot(loadAccountProfiles().privateCodexRoots(), {
    allowHostGithubCredentials: true,
  });
  const deniedRoots = privatePaths.roots;
  const workspaces = [...selection.workspaceRoots];
  const selectors = workspaceRuntimeSelectorEntries();
  const contains = (root: string, path: string) => {
    const child = relative(root, path);
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  };
  if (
    workspaces.some((root) => {
      const roots = [resolve(root), realpathSync(root)];
      return selectors.some((selector) =>
        roots.some((scope) => contains(scope, resolve(selector))),
      );
    })
  )
    throw Error('Native workspace contains a runtime authority selector');
  const writeProtectedRoots = workspaceRuntimeNativeAuthorityPaths().filter(
    (path) => !privatePaths.isPrivate(path),
  );
  const policy = codexNativeExecutionPolicy({
    bindingRevision:
      retainedBindingRevision ??
      createHash('sha256')
        .update(
          JSON.stringify([
            input.binding.accountId,
            input.binding.profileRevision,
            selection.authSessionId,
          ]),
        )
        .digest('hex'),
    mode: selection.mode,
    cwd: selection.cwd,
    readableRoots: input.readableRoots ?? ['/'],
    writableRoots: workspaces,
    deniedRoots,
    writeProtectedRoots,
  });
  current();
  return policy;
}

export const NATIVE_MAC_EXECUTION_INSTRUCTIONS =
  TASK_EXECUTION_INSTRUCTIONS +
  `
Native Codex tools execute on the selected Local Mac under its enforced filesystem and network profile.
Use native shell and file tools for permitted local work. Use the built-in native patch tool; the PATH apply_patch alias is unavailable under the private-home fence.
For an out-of-scope edit, request exact scoped native permissions first; durable file-change grantRoot is not supported. Do not retry an unchanged filesystem fence.
Ask starts with read-only workspace access;
Agent and Auto permit the admitted workspace writes. A grant adds only its displayed scope and duration.
Auto permits workspace-command networking; Agent requires network approval unless covered by an explicit current development grant. Changing modes takes effect at the next native turn.
Automatic review is unavailable on this account until its reviewer and billing route are qualified.
Escalations use explicit human review unless the existing workspace owner proves an already authorized exact task-root grant.
Denied, cancelled and expired requests do not authorize execution. Never claim execution without a native result.
Use native Git for normal add, commit and merge operations on the admitted task branch in the admitted task checkout; Agent and Auto include its .git metadata writes. Linked worktrees can still require exact permission for external Git administration.
When the user selects gh, use it for repository, PR, review and CI work through the existing signed-in account and native permissions. Reuse an already authorized native CLI route; a public API quota does not revoke that authority or require abandoning the task. Use GitHubRead for routine repository, PR, review and CI reads when the native CLI is not the selected route, including /repos/OWNER/REPO/actions/runs/RUN_ID and /repos/OWNER/REPO/actions/runs/RUN_ID/jobs. Its access: public mode uses no credentials and never silently retries that request with account credentials. This public-request boundary does not prohibit a separately authorized authenticated integration read or native gh command. Authenticated GitHubRead retains explicitly approved repository-read scope without granting shell networking or GitHub writes. Prefer bounded reads and wait between CI checks; reuse existing grants instead of requesting repeated networking approvals to poll status. Native gh also supports explicitly authorized publication and guarded merge; RequestGithubPublish remains the managed publication alternative. Network access and external Git administration use native approvals; request the exact missing permission instead of retrying an unchanged fence. The host GitHub CLI credential store is readable by native tools; do not print or copy credentials. No Telos assignment is required. A remote branch update does not synchronize the local checkout. Inspect remote state before retrying an interrupted mutation, and preserve required CI/review gates when merging.
Run offline tests with the existing workspace and temporary-directory permissions first. Do not request network access for an offline test unless a concrete failure establishes that it needs networking, such as a local test listener. Repeating an approved exact native command can use Allow for session; changes to its command, directory or requested access need a new approval. This is command consent, not permission to skip publication, merge or deployment authorization.
GitCommit is a separate narrow selected-file service where supplied, limited to 64 files and a clean index. Use native Git for larger commits or merges. Authenticated integrations remain trusted Mitzo tools where supplied.
`;

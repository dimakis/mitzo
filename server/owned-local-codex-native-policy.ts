import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { MitzoMode, AccountBinding } from '@mitzo/protocol';
import type { ManagedSession } from './session-registry.js';
import { loadAccountProfiles } from './account-profiles.js';
import { privateCodexPathSnapshot } from './codex-private-path.js';
import {
  workspaceRuntimeAuthorityPaths,
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
  const privatePaths = privateCodexPathSnapshot(loadAccountProfiles().privateCodexRoots());
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
  const writeProtectedRoots = [...workspaceRuntimeAuthorityPaths(), ...selectors].filter(
    (path) => !privatePaths.isPrivate(path),
  );
  const policy = codexNativeExecutionPolicy({
    bindingRevision: createHash('sha256')
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

export const NATIVE_MAC_EXECUTION_INSTRUCTIONS = `
Native Codex tools execute on the selected Local Mac under its enforced filesystem and network profile.
Use native shell and file tools for permitted local work. Use the built-in native patch tool; the PATH apply_patch alias is unavailable under the private-home fence.
For an out-of-scope edit, request exact scoped native permissions first; durable file-change grantRoot is not supported. Do not retry an unchanged filesystem fence.
Ask starts with read-only workspace access;
Agent and Auto permit the admitted workspace writes. A grant adds only its displayed scope and duration.
Automatic review is unavailable on this account until its reviewer and billing route are qualified.
Escalations use explicit human review unless the existing workspace owner proves an already authorized exact task-root grant.
Denied, cancelled and expired requests do not authorize execution. Never claim execution without a native result.
Use native Git for normal add, commit and merge operations on the admitted task branch in the admitted task checkout; Agent and Auto include its .git metadata writes. Linked worktrees can still require exact permission for external Git administration.
GitCommit is a separate narrow selected-file service where supplied, limited to 64 files and a clean index. Use native Git for larger commits or merges. Authenticated integrations remain trusted Mitzo tools where supplied.
`;

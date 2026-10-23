import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';
import type { ManagedSession } from './session-registry.js';
import { loadAccountProfiles } from './account-profiles.js';
import { isPrivateCodexPath, privateCodexRoots } from './codex-private-path.js';
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
  input.assertCurrentSync();
  const { session } = input;
  if (!session.cwd) throw Error('Native workspace unavailable');
  const deniedRoots = privateCodexRoots(loadAccountProfiles().privateCodexRoots());
  const workspaces = session.worktreePaths.size
    ? [...session.worktreePaths.values()].map((entry) => entry.path)
    : [session.cwd];
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
    (path) => !isPrivateCodexPath(path, deniedRoots),
  );
  const policy = codexNativeExecutionPolicy({
    bindingRevision: createHash('sha256')
      .update(
        JSON.stringify([
          input.binding.accountId,
          input.binding.profileRevision,
          session.ownedLocalAuthSessionId,
        ]),
      )
      .digest('hex'),
    mode: session.mode,
    cwd: session.cwd,
    readableRoots: input.readableRoots ?? ['/'],
    writableRoots: workspaces,
    deniedRoots,
    writeProtectedRoots,
  });
  input.assertCurrentSync();
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
GitCommit and authenticated integrations remain separate trusted Mitzo tools where supplied. GitCommit still requires existing current-task workspace custody.
`;

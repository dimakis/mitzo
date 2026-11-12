import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { NativeApprovalRequest } from './codex-native-permission-protocol.js';
import { nativeCommandDirectoryScope } from './codex-native-grant-fence.js';
import { githubReadCommandRepository } from '@mitzo/harness';

/** Decode only the observed native envelope: one literal argument to zsh -lc.
 * This classifies consent only; the original command is never rewritten.
 * Shell expansion, concatenated words and other envelopes retain exact consent.
 */
export function nativeGithubReadCommand(command: string) {
  const direct = githubReadCommandRepository(command);
  if (direct) return { repository: direct, shell: null };
  const prefix = '/bin/zsh -lc ';
  if (!command.startsWith(prefix) || /[\r\n\0]/.test(command)) return;
  const word = command.slice(prefix.length);
  const quote = word[0];
  if (quote !== "'" && quote !== '"') return;
  let decoded = '';
  let closed = false;
  for (let i = 1; i < word.length; i++) {
    const char = word[i]!;
    if (char === quote) {
      if (i !== word.length - 1) return;
      closed = true;
      break;
    }
    if (quote === '"') {
      if (char === '$' || char === '`') return;
      if (char === '\\') {
        const escaped = word[++i];
        if (!escaped || !['\\', '"', '$', '`'].includes(escaped)) return;
        decoded += escaped;
        continue;
      }
    }
    decoded += char;
  }
  if (!closed) return;
  const repository = githubReadCommandRepository(decoded);
  return repository ? { repository, shell: ['/bin/zsh', '-lc'] } : undefined;
}

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
  const githubRead = nativeGithubReadCommand(params.command);
  return `${githubRead ? 'native-github-read-v2' : 'native-command-v1'}:${createHash('sha256')
    .update(
      JSON.stringify([
        owner,
        directory,
        params.threadId,
        params.cwd,
        githubRead ?? params.command,
        params.additionalPermissions ?? null,
      ]),
    )
    .digest('hex')}`;
}

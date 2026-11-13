import { resolve } from 'node:path';
import { isPrivateCodexPath, protectCodexProfileRoots } from './codex-private-path.js';

/** Keep explicit file requests out of account storage. Local Mac Bash uses the
 * existing shared permissions; command-level credential isolation is deferred.
 * Do not require a second SDK sandbox inside the protected SDK process. */
export function claudePersonalToolPermission(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  configDirectory: string,
) {
  protectCodexProfileRoots([configDirectory]);
  if (
    ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'].includes(name) &&
    ['file_path', 'path', 'notebook_path'].some(
      (key) =>
        typeof input[key] === 'string' && isPrivateCodexPath(resolve(cwd, input[key] as string)),
    )
  ) {
    return {
      behavior: 'deny' as const,
      message: 'Claude sign-in and private account files are unavailable to agent tools',
    };
  }
}

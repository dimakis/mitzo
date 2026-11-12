import { resolve } from 'node:path';
import {
  isPrivateCodexPath,
  protectCodexProfileRoots,
  privateCodexRoots,
} from './codex-private-path.js';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

/** The native CLI may refresh its own login/history; model-requested tools may not read it. */
export function claudePersonalToolPermission(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  configDirectory: string,
) {
  protectCodexProfileRoots([configDirectory]);
  // Native recursive search runs outside the Bash sandbox and can traverse a
  // protected root from its ancestor, an absolute pattern or a nested alias.
  if (name === 'Grep' || name === 'Glob')
    return {
      behavior: 'deny' as const,
      message: 'Use sandboxed Bash for file searches so private account files stay protected.',
    };
  if (
    (name === 'Bash' && input.dangerouslyDisableSandbox === true) ||
    (['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'].includes(name) &&
      ['file_path', 'path', 'notebook_path'].some(
        (key) =>
          typeof input[key] === 'string' && isPrivateCodexPath(resolve(cwd, input[key] as string)),
      ))
  ) {
    return {
      behavior: 'deny' as const,
      message: 'Claude sign-in and private account files are unavailable to agent tools',
    };
  }
}
export function claudePersonalSandbox(
  configDirectory: string,
  unixSockets: readonly string[] = [],
): Options['sandbox'] {
  protectCodexProfileRoots([configDirectory]);
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    filesystem: { denyRead: privateCodexRoots(), denyWrite: privateCodexRoots() },
    // Exact host-owned broker sockets (shell gws); no other local IPC.
    ...(unixSockets.length ? { network: { allowUnixSockets: [...unixSockets] } } : {}),
  };
}

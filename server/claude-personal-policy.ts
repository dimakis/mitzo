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
export function claudePersonalSandbox(configDirectory: string): Options['sandbox'] {
  protectCodexProfileRoots([configDirectory]);
  return {
    enabled: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    filesystem: { denyRead: privateCodexRoots(), denyWrite: privateCodexRoots() },
  };
}

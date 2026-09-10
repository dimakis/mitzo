import { executeSandboxedCommand } from './sandboxed-command.js';
import { executeNativeFileOperation } from './native-file-operation.js';
import { executeTrustedGitCommit, executeTrustedGitHubRead } from './trusted-native-operation.js';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { loadAccountProfiles } from './account-profiles.js';
import { createCodexPathProtection, privateCodexRoots } from './codex-private-path.js';
import {
  buildPermissionHandler,
  effectivePermissionMode,
  checkSkillPolicy,
  UserQuestionsSchema,
  type SessionRegistry,
  type ToolDefinition,
  type ToolUseBlock,
  type ToolResultBlock,
} from '@mitzo/harness';

const approval = {
  require_approval: z
    .boolean()
    .optional()
    .describe('Set true to request an explicit Mitzo approval card before this exact action.'),
};
const privatePathSnapshot = createCodexPathProtection(() =>
  loadAccountProfiles().privateCodexRoots(),
);
const schemas = {
  AskUserQuestion: z.object({ questions: UserQuestionsSchema }).strict(),
  Bash: z
    .object({
      command: z.string().min(1).max(32000),
      ...approval,
    })
    .strict(),
  GitHubRead: z
    .object({
      endpoint: z
        .string()
        .min(1)
        .max(1000)
        .regex(/^\/(?:user|repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./?=&%+-]*)?)$/)
        .refine((value) => !value.includes('..') && !value.includes('//'), 'Invalid GitHub path'),
    })
    .strict(),
  GitCommit: z
    .object({
      files: z.array(z.string().min(1).max(1000)).min(1).max(64),
      message: z.string().min(1).max(500),
    })
    .strict(),
  Read: z.object({ file_path: z.string().min(1) }).strict(),
  Write: z.object({ file_path: z.string().min(1), content: z.string(), ...approval }).strict(),
  Edit: z
    .object({
      file_path: z.string().min(1),
      old_string: z.string().min(1),
      new_string: z.string(),
      ...approval,
    })
    .strict(),
};
const descriptions = {
  AskUserQuestion:
    'Ask structured questions in Mitzo and wait for the user’s answers. Questions do not authorize tool execution.',
  Bash: 'Run a command in the session workspace using an OS sandbox. Use for tests, Git and directory creation. Network and credentials are unavailable; use a dedicated trusted integration for external services. Writes outside session roots and unavailable sandboxes fail explicitly.',
  GitHubRead:
    'Perform one approved authenticated GitHub API GET through Mitzo. Credentials remain in the trusted host process and are never exposed to the command sandbox.',
  GitCommit:
    'Stage exactly the approved workspace files and create one local Git commit through Mitzo. Refuses an already-staged index and credential-like files.',
  Read: 'Read a UTF-8 file. Paths are relative to the session cwd unless absolute.',
  Write: 'Write a UTF-8 file in an existing directory.',
  Edit: 'Replace exactly one occurrence of old_string in a UTF-8 file.',
};
export const nativeToolDefinitions: ToolDefinition[] = Object.entries(schemas).map(
  ([name, schema]) => ({
    name,
    description: descriptions[name as keyof typeof schemas],
    input_schema: z.toJSONSchema(schema),
  }),
);

/** Resolve symlinks and traversal before presenting a path to the existing worktree guard. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err: unknown) {
    if (!(err instanceof Error) || !('code' in err) || err.code !== 'ENOENT') throw err;
    // ENOENT can mean a dangling symlink, not a missing directory entry.
    // Never reconstruct that symlink's lexical path as a safe creation target.
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (entry?.isSymbolicLink())
      throw new Error('Dangling symlink paths are unavailable', { cause: err });
    const parent = dirname(path);
    if (parent === path) throw err;
    return resolve(await canonicalPath(parent), basename(path));
  }
}

export interface NativeToolOptions {
  /** Explicit child environment. The executor never inherits process.env or API credentials. */
  env: Record<string, string>;
  forcePrompt?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onDemandCreate?: NonNullable<Parameters<typeof buildPermissionHandler>[2]>['onDemandCreate'];
}

/** Native side effects use the same skill → worktree → mode/approval policy as SDK tools. */
export function createNativeToolExecutor(
  clientId: string,
  registry: SessionRegistry,
  options: NativeToolOptions,
) {
  const canUseTool = buildPermissionHandler(clientId, registry, {
    onDemandCreate: options.onDemandCreate,
  });
  return async (block: ToolUseBlock, signal: AbortSignal): Promise<ToolResultBlock> => {
    const result = (content: string, is_error = false): ToolResultBlock => ({
      type: 'tool_result',
      tool_use_id: block.id,
      content,
      is_error,
    });
    try {
      signal.throwIfAborted();
      const session = registry.get(clientId);
      if (!session?.cwd) return result('Session workspace is unavailable', true);
      if (
        effectivePermissionMode(session) === 'ask' &&
        !['Read', 'AskUserQuestion', 'GitHubRead'].includes(block.name)
      )
        return result('Ask mode only permits read-only native tools', true);
      if (!Object.hasOwn(schemas, block.name)) return result('Native tool is unavailable', true);
      const parsed = schemas[block.name as keyof typeof schemas].safeParse(block.input);
      if (!parsed.success) return result('Invalid native tool input', true);
      if (block.name === 'AskUserQuestion') {
        const permission = await canUseTool(block.name, parsed.data, {
          signal,
          toolUseID: block.id,
        });
        signal.throwIfAborted();
        return permission.behavior === 'allow'
          ? result(JSON.stringify({ answers: permission.updatedInput?.answers }))
          : result(permission.message, true);
      }
      if (block.name === 'GitHubRead' && 'endpoint' in parsed.data) {
        const input = { endpoint: parsed.data.endpoint };
        const permission = await canUseTool(block.name, input, {
          signal,
          toolUseID: block.id,
          forcePrompt: true,
        });
        signal.throwIfAborted();
        if (permission.behavior !== 'allow') return result(permission.message, true);
        if (!isDeepStrictEqual(permission.updatedInput, input))
          return result('Tool input changed during approval; retry the tool', true);
        if (
          registry.get(clientId) !== session ||
          checkSkillPolicy(registry, clientId, block.name) === 'deny'
        )
          return result('Session permissions changed; retry the tool', true);
        return result(
          await executeTrustedGitHubRead(
            input.endpoint,
            signal,
            options.timeoutMs,
            options.maxOutputBytes,
          ),
        );
      }
      if (block.name === 'GitCommit' && 'files' in parsed.data) {
        const root = await realpath(session.cwd);
        const files: string[] = [];
        for (const requested of parsed.data.files) {
          const canonical = await canonicalPath(resolve(root, requested));
          if (canonical === root || !canonical.startsWith(root + '/'))
            return result('Git commit path is outside the session workspace', true);
          const info = await lstat(canonical).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          });
          if (info && !info.isFile())
            return result('Git commit paths must be regular files or tracked deletions', true);
          files.push(relative(root, canonical));
        }
        const input = { files: [...new Set(files)], message: parsed.data.message };
        const permission = await canUseTool(block.name, input, {
          signal,
          toolUseID: block.id,
          forcePrompt: true,
        });
        signal.throwIfAborted();
        if (permission.behavior !== 'allow') return result(permission.message, true);
        if (!isDeepStrictEqual(permission.updatedInput, input))
          return result('Tool input changed during approval; retry the tool', true);
        if (
          registry.get(clientId) !== session ||
          effectivePermissionMode(session) === 'ask' ||
          checkSkillPolicy(registry, clientId, block.name) === 'deny'
        )
          return result('Session permissions changed; retry the tool', true);
        return result(
          await executeTrustedGitCommit(
            root,
            input.files,
            input.message,
            signal,
            options.timeoutMs,
            options.maxOutputBytes,
          ),
        );
      }
      if (block.name === 'Bash' && 'command' in parsed.data) {
        const input = { command: parsed.data.command };
        const approvalMode = effectivePermissionMode(session);
        const permission = await canUseTool('Bash', input, {
          signal,
          toolUseID: block.id,
          forcePrompt: options.forcePrompt || parsed.data.require_approval === true,
        });
        signal.throwIfAborted();
        if (permission.behavior !== 'allow') return result(permission.message, true);
        if (!isDeepStrictEqual(permission.updatedInput, input))
          return result('Tool input changed during approval; retry the tool', true);
        if (registry.get(clientId) !== session || effectivePermissionMode(session) === 'ask')
          return result('Session permissions changed; retry the tool', true);
        // Resolve login roots anew; an unreadable account configuration fails closed.
        const deniedRoots = privateCodexRoots(loadAccountProfiles().privateCodexRoots());
        const roots = session.worktreePaths.size
          ? [...session.worktreePaths.values()].map((entry) => entry.path)
          : [session.cwd];
        const writableRoots = await Promise.all(roots.map((p) => realpath(p)));
        if (writableRoots.some((p) => privatePathSnapshot()(p)))
          return result('Private provider storage is unavailable', true);
        const output = await executeSandboxedCommand({
          command: input.command,
          cwd: await realpath(session.cwd),
          writableRoots,
          deniedRoots: await Promise.all(deniedRoots.map(canonicalPath)),
          env: options.env,
          signal,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
          beforeSpawn: () => {
            if (
              registry.get(clientId) !== session ||
              effectivePermissionMode(session) === 'ask' ||
              (approvalMode === 'auto' && effectivePermissionMode(session) !== 'auto') ||
              checkSkillPolicy(registry, clientId, 'Bash') === 'deny'
            )
              throw new Error(
                'Session permissions changed before command execution; retry the tool',
              );
          },
        });
        return result(output.content, output.isError);
      }
      const input = { ...parsed.data };
      if ('questions' in input || 'command' in input) return result('Invalid tool input', true);
      if (!('file_path' in input)) return result('Invalid file tool input', true);
      const isPrivate = privatePathSnapshot();
      const forcePrompt =
        options.forcePrompt === true ||
        ('require_approval' in input && input.require_approval === true);
      if ('require_approval' in input) delete input.require_approval;
      const roots: { canonical: string; original: string }[] = [];
      for (const entry of session.worktreePaths.values()) {
        try {
          roots.push({ canonical: await realpath(entry.path), original: entry.path });
        } catch {
          return result(
            'Session worktree is unavailable; restore the workspace before retrying',
            true,
          );
        }
      }
      const approvedPath = await canonicalPath(resolve(session.cwd, input.file_path));
      input.file_path = approvedPath;
      if (isPrivate(input.file_path))
        return result('Private provider storage is unavailable', true);
      // Present the checked path under the registry's original root alias. This keeps
      // the shared guard and lazy creation working without mutating registry entries.
      const root = roots.find(
        (entry) =>
          input.file_path === entry.canonical || input.file_path.startsWith(entry.canonical + '/'),
      );
      if (root) input.file_path = resolve(root.original, relative(root.canonical, input.file_path));
      const approvedParent = await lstat(dirname(approvedPath), { bigint: true });
      const parentIdentity = { dev: String(approvedParent.dev), ino: String(approvedParent.ino) };
      const approvedFile = await lstat(approvedPath, { bigint: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        },
      );
      const identity = approvedFile
        ? { dev: String(approvedFile.dev), ino: String(approvedFile.ino) }
        : null;
      const permission = await canUseTool(block.name, input, {
        signal,
        toolUseID: block.id,
        forcePrompt,
      });
      signal.throwIfAborted();
      if (permission.behavior !== 'allow') return result(permission.message, true);
      // The shared handler returns the checked input. Never execute unchecked replacements.
      if (!isDeepStrictEqual(permission.updatedInput, input))
        return result('Tool input changed during approval; retry the tool', true);
      if (
        (await canonicalPath(input.file_path)) !== approvedPath ||
        privatePathSnapshot()(input.file_path)
      )
        return result('Tool path changed or became private during approval; retry the tool', true);
      if (
        registry.get(clientId) !== session ||
        (block.name !== 'Read' && effectivePermissionMode(session) === 'ask') ||
        checkSkillPolicy(registry, clientId, block.name) === 'deny'
      )
        return result('Session permissions changed before file execution; retry the tool', true);
      const operation = await executeNativeFileOperation(
        {
          ...input,
          operation: block.name,
          identity,
          parentIdentity,
          file_path: approvedPath,
          limit: options.maxOutputBytes ?? 64 * 1024,
        },
        signal,
        options.timeoutMs,
      );
      return result(operation.content, operation.is_error);
    } catch (err: unknown) {
      return result(
        signal.aborted
          ? 'Tool execution cancelled'
          : err instanceof Error
            ? err.message
            : 'Native tool execution failed',
        true,
      );
    }
  };
}

import { copyCallbackOutcome, retainCallbackOutcome } from './turn-callbacks.js';
import {
  getRepositoryWorkspaces,
  readRepositoryWorkspaceForConversation,
} from './repository-workspace-runtime.js';
import { executeSandboxedCommand } from './sandboxed-command.js';
import { executeNativeFileOperation } from './native-file-operation.js';
import {
  executeTrustedGitCommit,
  executeTrustedGitHubRead,
  isTrustedGitHubEndpoint,
} from './trusted-native-operation.js';
import { lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { loadAccountProfiles } from './account-profiles.js';
import { toolInputError } from './tool-input-error.js';
import { authorizeGitHubRead } from './github-read-approval.js';
import { executePublicGitHubRead } from './public-github-read.js';
import { GithubLogReadSchema, validateGithubLogRead } from './github-log-read.js';
import { createCodexPathProtection, privateCodexRoots } from './codex-private-path.js';
import {
  workspaceRuntimeAuthorityPaths,
  workspaceRuntimeSelectorEntries,
  isWorkspaceRuntimeAuthorityWritePath,
} from './workspace-runtime-private-paths.js';
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
      log: GithubLogReadSchema.optional().describe(
        'Authenticated CI job log paging: optional literal query, UTF-16 offset and character limit (up to 16000). Use /repos/OWNER/REPO/actions/jobs/JOB_ID/logs. Source is bounded to 8 MiB; follow nextOffset until null.',
      ),
      endpoint: z
        .string()
        .min(1)
        .max(1000)
        .regex(/^\/(?:user|repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./?=&%+-]*)?)$/)
        .refine(isTrustedGitHubEndpoint, 'Invalid GitHub path'),
      access: z
        .enum(['public', 'authenticated'])
        .optional()
        .describe(
          'Use public for credential-free public repository reads without an ordinary approval card. Authenticated is the compatibility default and requires repository consent. A failed public read never uses account credentials automatically.',
        ),
      view: z
        .enum(['summary', 'full'])
        .optional()
        .describe(
          'Known list endpoints default to concise fields before the output bound. Use full only when missing record detail is required; the existing output bound still applies.',
        ),
    })
    .strict()
    .refine(
      (input) => input.access !== 'public' || input.endpoint.startsWith('/repos/'),
      'Public access requires a repository endpoint; /user requires authenticated access',
    )
    .describe(
      'GitHubRead accepts /user or /repos/OWNER/REPO/... with a leading slash and URL-encoded query values. /search endpoints are unavailable in this tool. Use a selected connection guide for supported search operations. Prefer small per_page values and narrow reads.',
    ),
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
    'Read GitHub repository data through Mitzo. Use access: public for credential-free public reads without an ordinary approval card. Each public request never silently retries with credentials. Separately authorized authenticated reads or native gh commands retain their own permissions; honor an explicit CLI choice. Authenticated integration reads require repository consent; credentials remain private to Mitzo.',
  GitCommit:
    'Stage up to 64 approved workspace files and create one local Git commit through Mitzo. Refuses an already-staged index and credential-like files. Use native Git in the admitted task checkout for larger commits and merges.',
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
  /** Host-owned task proof for one exact call, never accepted from tool JSON. */
  taskAuthorization?: {
    readonly grantId: string;
    readonly toolName: 'Bash' | 'GitHubRead' | 'GitCommit';
    readonly input: Readonly<Record<string, unknown>>;
    readonly cwd?: string;
    assertCurrentSync(): void;
  };
  /** Optional enrolled-route owner fence, rechecked after approval and at effects. */
  assertRuntimeCurrent?: () => void;
  /** Enrolled source/credential owners may need asynchronous grant reconciliation. */
  assertRuntimeCurrentAsync?: () => Promise<void>;
  /** Selected credential runtime identity; reconnecting a transport does not change it. */
  githubReadRuntimeId?: string;
  /** Native RPC owner rechecks consent immediately before delivering its reply. */
  registerResponseFence?: (assertCurrent: () => void) => void;
  /** Explicit child environment. The executor never inherits process.env or API credentials. */
  env: Record<string, string>;
  /** Server-owned, explicitly enabled host route. Requires the network-aware Bash grant. */
  networkAccess?: 'approved-command' | 'loopback';
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
  const networkAccess = options.networkAccess;
  const onDemandCreate = options.onDemandCreate;
  return async (block: ToolUseBlock, signal: AbortSignal): Promise<ToolResultBlock> => {
    const task = options.taskAuthorization;
    const taskName = task?.toolName;
    const taskId = task?.grantId;
    const taskCwd = task?.cwd;
    const taskAssertion = task?.assertCurrentSync;
    const taskInput = task ? structuredClone(task.input) : undefined;
    const assertCurrent = () => {
      signal.throwIfAborted();
      options.assertRuntimeCurrent?.();
      if (task) {
        if (
          options.taskAuthorization !== task ||
          !taskId ||
          task.grantId !== taskId ||
          task.toolName !== taskName ||
          taskName !== block.name ||
          task.cwd !== taskCwd ||
          task.assertCurrentSync !== taskAssertion ||
          !isDeepStrictEqual(block.input, taskInput) ||
          !isDeepStrictEqual(task.input, taskInput)
        )
          throw Error('Task authorization does not match this exact operation');
        task.assertCurrentSync();
      }
    };
    const taskConsent = task
      ? {
          isRetainedSessionGrantCurrent: () => {
            assertCurrent();
            return true;
          },
          sessionGrantKey: `task-execution:${task.grantId}:${block.name}`,
          allowSessionGrant: true,
        }
      : {};
    // This original invocation can prove it never delegated an effect. Once
    // any executor (including lazy workspace creation) starts, errors stay
    // uncertain unless that executor supplies its own settlement evidence.
    let executionStarted = false;
    const canUseTool = buildPermissionHandler(clientId, registry, {
      onDemandCreate: onDemandCreate
        ? async (path) => {
            const previouslyStarted = executionStarted;
            executionStarted = true;
            const created = await onDemandCreate(path);
            // A positive original creation result closes that preparation.
            // Null/throw cannot establish whether creation partially applied.
            if (created) executionStarted = previouslyStarted;
            return created;
          }
        : undefined,
    });
    const result = (content: string, is_error = false): ToolResultBlock => ({
      type: 'tool_result',
      tool_use_id: block.id,
      content,
      is_error,
    });
    const refused = (content: string) =>
      retainCallbackOutcome(result(content, true), executionStarted ? 'unknown' : 'settled');
    try {
      signal.throwIfAborted();
      await options.assertRuntimeCurrentAsync?.();
      assertCurrent();
      const session = registry.get(clientId);
      if (!session?.cwd) return refused('Session workspace is unavailable');
      if (
        effectivePermissionMode(session) === 'ask' &&
        !['Read', 'AskUserQuestion', 'GitHubRead'].includes(block.name)
      )
        return refused('Ask mode only permits read-only native tools');
      if (!Object.hasOwn(schemas, block.name)) return refused('Native tool is unavailable');
      const parsed = schemas[block.name as keyof typeof schemas].safeParse(block.input);
      if (!parsed.success) {
        if (
          block.name === 'GitCommit' &&
          parsed.error.issues.some(
            (issue) =>
              issue.code === 'too_big' && issue.path.length === 1 && issue.path[0] === 'files',
          )
        )
          return refused(
            'GitCommit supports at most 64 selected files. Use native Git in the admitted task checkout for larger commits and merges.',
          );
        const invalid = toolInputError(
          'native tool input',
          schemas[block.name as keyof typeof schemas],
          parsed.error,
        );
        return copyCallbackOutcome(invalid, result(invalid.content, true));
      }
      if (block.name === 'AskUserQuestion') {
        const permission = await canUseTool(block.name, parsed.data, {
          signal,
          toolUseID: block.id,
        });
        signal.throwIfAborted();
        return permission.behavior === 'allow'
          ? result(JSON.stringify({ answers: permission.updatedInput?.answers }))
          : refused(permission.message);
      }
      if (block.name === 'GitHubRead' && 'endpoint' in parsed.data) {
        const log =
          'log' in parsed.data && parsed.data.log !== undefined
            ? validateGithubLogRead(parsed.data.endpoint, parsed.data.log)
            : undefined;
        if (log && parsed.data.access === 'public')
          return refused(
            'Log paging requires a separately authorized authenticated GitHub read; public reads never switch credentials automatically',
          );
        const input = {
          endpoint: parsed.data.endpoint,
          ...(log ? { log } : {}),
          ...('access' in parsed.data && parsed.data.access ? { access: parsed.data.access } : {}),
          ...('view' in parsed.data && parsed.data.view ? { view: parsed.data.view } : {}),
        };
        const assertReadCurrent = await authorizeGitHubRead(input, {
          clientId,
          registry,
          session,
          runtimeId: options.githubReadRuntimeId,
          signal,
          toolUseID: block.id,
          decide: canUseTool,
          forcePrompt: options.forcePrompt,
          assertCurrentSync: options.assertRuntimeCurrent,
          assertCurrentAsync: options.assertRuntimeCurrentAsync,
          ...(task ? { assertTaskAuthorizationCurrent: assertCurrent } : {}),
        });
        options.registerResponseFence?.(assertReadCurrent);
        const executeRead =
          input.access === 'public' ? executePublicGitHubRead : executeTrustedGitHubRead;
        executionStarted = true;
        const content = await executeRead(
          input.endpoint,
          signal,
          options.timeoutMs,
          options.maxOutputBytes,
          input.view,
          assertReadCurrent,
          ...(log ? ([log] as const) : []),
        );
        assertReadCurrent();
        return result(content);
      }
      if (block.name === 'GitCommit' && 'files' in parsed.data) {
        const root = await realpath(session.cwd);
        const files: string[] = [];
        const approvedIdentities = new Map<
          string,
          { dev: number; ino: number; sha256: string } | null
        >();
        for (const requested of parsed.data.files) {
          const canonical = await canonicalPath(resolve(root, requested));
          if (privatePathSnapshot()(canonical) || isWorkspaceRuntimeAuthorityWritePath(canonical))
            return refused('Private provider storage or runtime authority is unavailable');
          if (canonical === root || !canonical.startsWith(root + '/'))
            return refused('Git commit path is outside the session workspace');
          const info = await lstat(canonical).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          });
          if (info && !info.isFile())
            return refused('Git commit paths must be regular files or tracked deletions');
          const file = relative(root, canonical);
          files.push(file);
          if (info) {
            const content = await readFile(canonical);
            const afterRead = await lstat(canonical);
            if (
              (await realpath(canonical)) !== canonical ||
              afterRead.dev !== info.dev ||
              afterRead.ino !== info.ino ||
              afterRead.size !== info.size ||
              afterRead.mtimeMs !== info.mtimeMs
            )
              return refused('Git commit path changed while preparing approval; retry');
            approvedIdentities.set(file, {
              dev: info.dev,
              ino: info.ino,
              sha256: createHash('sha256').update(content).digest('hex'),
            });
          } else approvedIdentities.set(file, null);
        }
        const input = { files: [...new Set(files)], message: parsed.data.message };
        const permission = await canUseTool(block.name, input, {
          signal,
          toolUseID: block.id,
          forcePrompt: true,
          ...taskConsent,
        });
        signal.throwIfAborted();
        if (permission.behavior !== 'allow') return refused(permission.message);
        if (!isDeepStrictEqual(permission.updatedInput, input))
          return refused('Tool input changed during approval; retry the tool');
        if (
          registry.get(clientId) !== session ||
          effectivePermissionMode(session) === 'ask' ||
          checkSkillPolicy(registry, clientId, block.name) === 'deny'
        )
          return refused('Session permissions changed; retry the tool');
        const repositoryTask = session.sessionId
          ? readRepositoryWorkspaceForConversation(session.sessionId)
          : undefined;
        const task = repositoryTask
          ? await getRepositoryWorkspaces(true).validateHostTask(session.sessionId!, root)
          : undefined;
        await options.assertRuntimeCurrentAsync?.();
        assertCurrent();
        executionStarted = true;
        return result(
          await executeTrustedGitCommit(
            root,
            input.files,
            input.message,
            signal,
            options.timeoutMs,
            options.maxOutputBytes,
            new Map(input.files.map((file) => [file, approvedIdentities.get(file) ?? null])),
            task,
            ...(options.assertRuntimeCurrentAsync
              ? ([assertCurrent, options.assertRuntimeCurrentAsync] as const)
              : options.assertRuntimeCurrent || task
                ? ([assertCurrent] as const)
                : ([] as const)),
          ),
        );
      }
      if (block.name === 'Bash' && 'command' in parsed.data) {
        const input = {
          command: parsed.data.command,
          ...(networkAccess ? { networkAccess } : {}),
        };
        const approvalMode = effectivePermissionMode(session);
        const permission = await canUseTool('Bash', input, {
          signal,
          toolUseID: block.id,
          forcePrompt: options.forcePrompt || parsed.data.require_approval === true,
          ...(!options.forcePrompt && !parsed.data.require_approval ? taskConsent : {}),
          ...(networkAccess === 'approved-command'
            ? {
                title: 'Run command with network access',
                description:
                  'Runs on the local host in this conversation’s Git workspace with network access, including local test servers. Connection credentials remain private to Mitzo.',
                sessionGrantKey: 'host-network-bash-v1',
                sessionGrantDescription:
                  'Bash commands with network access and local test servers in this conversation’s Git workspace.',
              }
            : {}),
        });
        signal.throwIfAborted();
        if (permission.behavior !== 'allow') return refused(permission.message);
        if (!isDeepStrictEqual(permission.updatedInput, input))
          return refused('Tool input changed during approval; retry the tool');
        if (registry.get(clientId) !== session || effectivePermissionMode(session) === 'ask')
          return refused('Session permissions changed; retry the tool');
        // Resolve login roots anew; an unreadable account configuration fails closed.
        const deniedRoots = privateCodexRoots(loadAccountProfiles().privateCodexRoots());
        const roots = session.worktreePaths.size
          ? [...session.worktreePaths.values()].map((entry) => entry.path)
          : [session.cwd];
        const writableRoots = await Promise.all(roots.map((p) => realpath(p)));
        const selectedAuthority = workspaceRuntimeAuthorityPaths();
        const runtimeAuthority = [
          ...selectedAuthority,
          ...(await Promise.all(selectedAuthority.map(canonicalPath))),
        ];
        const selectorEntries = workspaceRuntimeSelectorEntries();
        if (
          writableRoots.some((root) =>
            selectorEntries.some((entry) => entry === root || entry.startsWith(root + '/')),
          ) ||
          writableRoots.some((root) =>
            runtimeAuthority.some(
              (authority) =>
                root === authority ||
                authority.startsWith(root + '/') ||
                root.startsWith(authority + '/'),
            ),
          )
        )
          return refused(
            'Command workspace overlaps workspace runtime authority. Move operator enrollment and runtime files outside writable task roots.',
          );
        if (writableRoots.some((p) => privatePathSnapshot()(p)))
          return refused('Private provider storage is unavailable');
        await options.assertRuntimeCurrentAsync?.();
        assertCurrent();
        executionStarted = true;
        const output = await executeSandboxedCommand({
          command: input.command,
          cwd: await realpath(taskCwd ?? session.cwd),
          writableRoots,
          deniedRoots: await Promise.all(deniedRoots.map(canonicalPath)),
          env: options.env,
          networkAccess,
          signal,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
          beforeSpawnAsync: options.assertRuntimeCurrentAsync,
          beforeSpawn: () => {
            assertCurrent();
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
        return copyCallbackOutcome(output, result(output.content, output.isError));
      }
      const input = { ...parsed.data };
      if ('questions' in input || 'command' in input) return refused('Invalid tool input');
      if (!('file_path' in input)) return refused('Invalid file tool input');
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
          return refused('Session worktree is unavailable; restore the workspace before retrying');
        }
      }
      const approvedPath = await canonicalPath(resolve(session.cwd, input.file_path));
      input.file_path = approvedPath;
      if (isPrivate(input.file_path)) return refused('Private provider storage is unavailable');
      if (block.name !== 'Read' && isWorkspaceRuntimeAuthorityWritePath(approvedPath))
        return refused('Workspace runtime authority is unavailable for writes');
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
      if (permission.behavior !== 'allow') return refused(permission.message);
      // The shared handler returns the checked input. Never execute unchecked replacements.
      if (!isDeepStrictEqual(permission.updatedInput, input))
        return refused('Tool input changed during approval; retry the tool');
      if (
        (await canonicalPath(input.file_path)) !== approvedPath ||
        privatePathSnapshot()(input.file_path) ||
        (block.name !== 'Read' && isWorkspaceRuntimeAuthorityWritePath(input.file_path))
      )
        return refused('Tool path changed or became private during approval; retry the tool');
      if (
        registry.get(clientId) !== session ||
        (block.name !== 'Read' && effectivePermissionMode(session) === 'ask') ||
        checkSkillPolicy(registry, clientId, block.name) === 'deny'
      )
        return refused('Session permissions changed before file execution; retry the tool');
      await options.assertRuntimeCurrentAsync?.();
      assertCurrent();
      executionStarted = true;
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
      const failure = refused(
        signal.aborted
          ? 'Tool execution cancelled'
          : err instanceof Error
            ? err.message
            : 'Native tool execution failed',
      );
      return err instanceof Error && !signal.aborted ? copyCallbackOutcome(err, failure) : failure;
    }
  };
}

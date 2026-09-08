import { open, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { loadAccountProfiles } from './account-profiles.js';
import { createCodexPathProtection } from './codex-private-path.js';
import {
  buildPermissionHandler,
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

async function readBounded(path: string, limit: number, signal: AbortSignal): Promise<string> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new Error('File exceeds native read/edit size limit');
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await file.close();
  }
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
      if (session.mode === 'ask' && !['Read', 'AskUserQuestion'].includes(block.name))
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
      const input = { ...parsed.data };
      if ('questions' in input) return result('Invalid tool input', true);
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
      if ('file_path' in input) {
        input.file_path = await canonicalPath(resolve(session.cwd, input.file_path));
        if (isPrivate(input.file_path))
          return result('Private provider storage is unavailable', true);
        // Present the checked path under the registry's original root alias. This keeps
        // the shared guard and lazy creation working without mutating registry entries.
        const root = roots.find(
          (entry) =>
            input.file_path === entry.canonical ||
            input.file_path.startsWith(entry.canonical + '/'),
        );
        if (root)
          input.file_path = resolve(root.original, relative(root.canonical, input.file_path));
      }
      const approvedPath = await canonicalPath(input.file_path);
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
      if (block.name === 'Write') {
        const write = schemas.Write.parse(input);
        await writeFile(write.file_path, write.content, { encoding: 'utf8', signal });
        return result('File written');
      }
      const content = await readBounded(
        input.file_path,
        options.maxOutputBytes ?? 64 * 1024,
        signal,
      );
      if (block.name === 'Edit') {
        const edit = schemas.Edit.parse(input);
        if (
          !content.includes(edit.old_string) ||
          content.indexOf(edit.old_string) !== content.lastIndexOf(edit.old_string)
        )
          return result('Edit requires exactly one matching occurrence', true);
        await writeFile(
          input.file_path,
          content.replace(edit.old_string, () => edit.new_string),
          { encoding: 'utf8', signal },
        );
        return result('File edited');
      }
      return result(content);
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

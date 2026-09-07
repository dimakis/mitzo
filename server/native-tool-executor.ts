import { spawn } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  buildPermissionHandler,
  type SessionRegistry,
  type ToolDefinition,
  type ToolUseBlock,
  type ToolResultBlock,
} from '@mitzo/harness';

const schemas = {
  Read: z.object({ file_path: z.string().min(1) }).strict(),
  Write: z.object({ file_path: z.string().min(1), content: z.string() }).strict(),
  Edit: z
    .object({ file_path: z.string().min(1), old_string: z.string().min(1), new_string: z.string() })
    .strict(),
  Bash: z.object({ command: z.string().min(1) }).strict(),
};
const descriptions = {
  Read: 'Read a UTF-8 file. Paths are relative to the session cwd unless absolute.',
  Write: 'Write a UTF-8 file in an existing directory.',
  Edit: 'Replace exactly one occurrence of old_string in a UTF-8 file.',
  Bash: 'Run a shell command in the session cwd. Commands have a bounded runtime and output.',
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
  timeoutMs?: number;
  maxOutputBytes?: number;
  onDemandCreate?: NonNullable<Parameters<typeof buildPermissionHandler>[2]>['onDemandCreate'];
}

function shell(
  command: string,
  cwd: string,
  signal: AbortSignal,
  options: NativeToolOptions,
): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let failure: string | undefined;
    const kill = (reason: string) => {
      failure ??= reason;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    };
    const onAbort = () => kill('Tool execution cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const timer = setTimeout(() => kill('Shell command timed out'), options.timeoutMs ?? 60_000);
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxOutputBytes ?? 64 * 1024)) kill('Shell output limit exceeded');
      else chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    child.on('error', () => {
      cleanup();
      reject(new Error('Shell command could not start'));
    });
    child.on('close', (code) => {
      cleanup();
      const output =
        Buffer.concat(stdout).toString('utf8') +
        (stderr.length ? `\n--- stderr ---\n${Buffer.concat(stderr).toString('utf8')}` : '');
      if (failure) reject(new Error(failure));
      else if (code !== 0) reject(new Error(`Shell exited with code ${code}: ${output}`));
      else resolveResult(output);
    });
  });
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
      if (session.mode === 'ask' && block.name !== 'Read')
        return result('Ask mode only permits read-only native tools', true);
      if (!Object.hasOwn(schemas, block.name)) return result('Native tool is unavailable', true);
      const parsed = schemas[block.name as keyof typeof schemas].safeParse(block.input);
      if (!parsed.success) return result('Invalid native tool input', true);
      const input = { ...parsed.data };
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
      const permission = await canUseTool(block.name, input, { signal, toolUseID: block.id });
      signal.throwIfAborted();
      if (permission.behavior !== 'allow') return result(permission.message, true);
      // The shared handler returns the checked input. Never execute unchecked replacements.
      if (!isDeepStrictEqual(permission.updatedInput, input))
        return result('Tool input changed during approval; retry the tool', true);
      if ('command' in input)
        return result(await shell(input.command, session.cwd, signal, options));
      if (block.name === 'Write') {
        const write = schemas.Write.parse(input);
        await writeFile(write.file_path, write.content, { encoding: 'utf8', signal });
        return result('File written');
      }
      const content = await readFile(input.file_path, { encoding: 'utf8', signal });
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
      if (Buffer.byteLength(content) > (options.maxOutputBytes ?? 64 * 1024))
        return result('File exceeds native read output limit', true);
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, link, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistry } from '@mitzo/harness';

const race = vi.hoisted(() => ({ run: undefined as undefined | (() => void), afterOpen: '' }));
// Trigger at the actual execution boundary, after all path/permission checks.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const run = race.run;
      race.run = undefined;
      await run?.();
      return actual.writeFile(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const run = race.run;
      race.run = undefined;
      await run?.();
      return actual.open(...args);
    },
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (...args: Parameters<typeof actual.execFile>) => {
      // Fixture mutation is synchronous here so stdin/process behavior remains real.
      const run = race.run;
      race.run = undefined;
      run?.();
      if (race.afterOpen && Array.isArray(args[1])) {
        args[1] = args[1].map((arg) =>
          arg.includes('        info = os.fstat(file)')
            ? arg.replace(
                '        info = os.fstat(file)',
                race.afterOpen + '\n        info = os.fstat(file)',
              )
            : arg,
        );
      }
      return actual.execFile(...args);
    },
  };
});
import { executeNativeFileOperation } from '../native-file-operation.js';
import { createNativeToolExecutor } from '../native-tool-executor.js';

async function identity(path: string) {
  const info = await lstat(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
}
const dirs: string[] = [];
afterEach(async () => {
  race.run = undefined;
  race.afterOpen = '';
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe('native filesystem races after authorization', () => {
  it.each(
    ['Read', 'Write', 'Edit'].flatMap((name) =>
      ['ancestor', 'file'].map((component) => ({ name, component })),
    ),
  )('does not redirect $name through a replaced $component', async ({ name, component }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-fd-race-')));
    dirs.push(root);
    const workspace = join(root, 'work');
    const privateRoot = join(root, 'private');
    await mkdir(workspace);
    await mkdir(join(workspace, 'dir'));
    await mkdir(privateRoot);
    await writeFile(join(workspace, 'dir/note'), 'original');
    await writeFile(join(privateRoot, 'note'), 'synthetic-private');
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', privateRoot);
    const registry = new SessionRegistry();
    const controller = new AbortController();
    registry.register('client', {
      transport: { send: () => {}, isOpen: () => true },
      abortController: controller,
      sessionId: 'test',
      cwd: workspace,
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    registry.get('client')!.worktreePaths.set('repo', { path: workspace, wtId: 'test' });
    race.run = () => {
      if (component === 'ancestor') {
        renameSync(join(workspace, 'dir'), join(workspace, 'original-dir'));
        symlinkSync(privateRoot, join(workspace, 'dir'));
      } else {
        unlinkSync(join(workspace, 'dir/note'));
        symlinkSync(join(privateRoot, 'note'), join(workspace, 'dir/note'));
      }
    };
    try {
      const result = await createNativeToolExecutor('client', registry, { env: {} })(
        {
          type: 'tool_use',
          id: 'race',
          name,
          input: {
            file_path: 'dir/note',
            ...(name === 'Write'
              ? { content: 'changed' }
              : name === 'Edit'
                ? { old_string: 'synthetic-private', new_string: 'changed' }
                : {}),
          },
        },
        controller.signal,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).not.toContain('synthetic-private');
      expect(await readFile(join(privateRoot, 'note'), 'utf8')).toBe('synthetic-private');
    } finally {
      registry.dispose();
    }
  });
  it.each(['Read', 'Write', 'Edit'])(
    'keeps %s on the opened file after pathname replacement',
    async (operation) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-pinned-')));
      dirs.push(root);
      const target = join(root, 'note');
      const original = join(root, 'original');
      const outside = join(root, 'outside');
      await writeFile(target, 'original');
      await writeFile(outside, 'synthetic-private');
      race.afterOpen = `        os.rename(${JSON.stringify(target)}, ${JSON.stringify(original)})
        os.symlink(${JSON.stringify(outside)}, ${JSON.stringify(target)})`;
      const result = await executeNativeFileOperation(
        {
          operation,
          identity: await identity(target),
          file_path: target,
          limit: 1024,
          content: 'changed',
          old_string: 'original',
          new_string: 'changed',
        },
        new AbortController().signal,
      );
      expect(result).toEqual({
        is_error: false,
        content:
          operation === 'Read'
            ? 'original'
            : operation === 'Write'
              ? 'File written'
              : 'File edited',
      });
      expect(await readFile(outside, 'utf8')).toBe('synthetic-private');
      expect(await readFile(original, 'utf8')).toBe(operation === 'Read' ? 'original' : 'changed');
    },
  );
  it('rejects hard-link aliases without reading or truncating their contents', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-hardlink-')));
    dirs.push(root);
    const outside = join(root, 'private');
    const alias = join(root, 'alias');
    await writeFile(outside, 'synthetic-private');
    await link(outside, alias);
    for (const operation of ['Read', 'Write', 'Edit']) {
      const result = await executeNativeFileOperation(
        {
          operation,
          identity: await identity(alias),
          file_path: alias,
          limit: 1024,
          content: 'changed',
          old_string: 'synthetic-private',
          new_string: 'changed',
        },
        new AbortController().signal,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).not.toContain('synthetic-private');
      expect(await readFile(outside, 'utf8')).toBe('synthetic-private');
    }
  });
  it('truncates shorter Unicode writes on the same descriptor', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-utf8-')));
    dirs.push(root);
    const file_path = join(root, 'note');
    await writeFile(file_path, 'long previous content');
    for (const content of ['hé🙂', '']) {
      expect(
        await executeNativeFileOperation(
          {
            operation: 'Write',
            identity: await identity(file_path),
            file_path,
            limit: 1024,
            content,
          },
          new AbortController().signal,
        ),
      ).toMatchObject({ is_error: false });
      expect(await readFile(file_path, 'utf8')).toBe(content);
    }
  });
  it.each([true, false])(
    'rejects a different file occupying the approved name (existed: %s)',
    async (existed) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-identity-')));
      dirs.push(root);
      const file_path = join(root, 'note');
      const replacement = join(root, 'replacement');
      if (existed) await writeFile(file_path, 'approved');
      const expected = existed ? await identity(file_path) : null;
      await writeFile(replacement, 'unapproved');
      // Keep the old inode alive so the fixture cannot accidentally reuse it.
      if (existed) renameSync(file_path, join(root, 'old'));
      renameSync(replacement, file_path);
      expect(
        await executeNativeFileOperation(
          { operation: 'Write', identity: expected, file_path, limit: 1024, content: 'changed' },
          new AbortController().signal,
        ),
      ).toMatchObject({ is_error: true });
      expect(await readFile(file_path, 'utf8')).toBe('unapproved');
    },
  );
});

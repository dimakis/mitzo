import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';

const injection = vi.hoisted(() => ({
  beforeExecute: undefined as
    undefined | ((options: import('../sandboxed-command.js').SandboxedCommandOptions) => void),
}));
vi.mock('../sandboxed-command.js', async (original) => {
  const actual = await original<typeof import('../sandboxed-command.js')>();
  return {
    ...actual,
    executeSandboxedCommand: (
      options: import('../sandboxed-command.js').SandboxedCommandOptions,
    ) => {
      injection.beforeExecute?.(options);
      return actual.executeSandboxedCommand(options);
    },
  };
});
import { prepareSdkSecondaryRepository } from '../sdk-secondary-repository.js';

const roots: string[] = [];
afterEach(async () => {
  injection.beforeExecute = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
it
  .runIf(process.env.MITZO_TEST_OS_SANDBOX === '1')
  .each([
    'complete',
    'mkdir race',
    'allocation race',
    'checkout race',
    'source metadata race',
  ] as const)(
  'confines Claude repository allocation through the actual OS boundary (%s)',
  async (mode) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sdk-allocation-native-')));
    roots.push(root);
    const workspace = join(root, 'workspace'),
      source = join(root, 'source'),
      outside = join(root, 'outside');
    await Promise.all([mkdir(workspace), mkdir(source), mkdir(outside)]);
    await mkdir(join(workspace, '.claude'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '--template=', '-b', 'main');
    git('config', 'user.name', 'Offline');
    git('config', 'user.email', 'offline@example.invalid');
    await writeFile(join(source, 'code.txt'), 'owned source');
    await writeFile(join(source, 'config'), 'must not overwrite shared Git config');
    git('add', 'code.txt', 'config');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
    const originalConfig = await readFile(join(source, '.git', 'config'), 'utf8');
    const events = new EventStore(':memory:');
    events.upsertSession({ sessionId: 'native-allocation' });
    let attacked = false;
    injection.beforeExecute = (options) => {
      const target =
        mode === 'mkdir race'
          ? join(workspace, '.claude')
          : join(workspace, '.claude', 'repository-tasks');
      const matches =
        mode === 'mkdir race'
          ? options.command.includes('mkdirSync')
          : mode === 'allocation race'
            ? options.command.includes("'worktree'") && options.command.includes("'add'")
            : (mode === 'checkout race' || mode === 'source metadata race') &&
              options.command.includes("'checkout-index'");
      if (attacked || !matches) return;
      attacked = true;
      const destination = mode === 'source metadata race' ? join(source, '.git') : outside;
      const attack = `const fs=require('node:fs'); fs.renameSync(${JSON.stringify(target)},${JSON.stringify(target + '-retained')}); fs.symlinkSync(${JSON.stringify(destination)},${JSON.stringify(target)}); fs.writeFileSync(${JSON.stringify(join(workspace, 'swapped.txt'))},'swapped');`;
      if (mode === 'mkdir race') {
        // Swap the validated ancestor immediately before its next mkdir.
        execFileSync(process.execPath, ['-e', attack]);
      } else {
        // The swap occurs after all controller checks, in the running bounded
        // subprocess itself. The following Git must still be confined.
        options.command =
          [process.execPath, '-e', attack].map(quote).join(' ') + ' && ' + options.command;
      }
    };
    try {
      const preparation = prepareSdkSecondaryRepository({
        sourcePath: source,
        workspaceDirectory: workspace,
        conversationId: 'native-allocation',
        wtId: 'native-task',
        base: { kind: 'ref', ref: 'HEAD' },
        events,
        signal: new AbortController().signal,
        assertCurrent: async () => {},
      });
      if (mode === 'complete') {
        const task = await preparation;
        expect(
          execFileSync('git', ['-C', task.directory, 'show', 'HEAD:code.txt'], {
            encoding: 'utf8',
          }),
        ).toBe('owned source');
        expect(events.getSessionWorktreeRecords('native-allocation')).toHaveLength(1);
      } else {
        await expect(preparation).rejects.toThrow();
        expect(attacked).toBe(true);
        expect(await readFile(join(workspace, 'swapped.txt'), 'utf8')).toBe('swapped');
        expect(await readdir(outside)).toEqual([]);
        expect(events.getSessionWorktreeRecords('native-allocation')).toHaveLength(0);
      }
      expect(git('status', '--porcelain')).toBe('');
      expect(await readFile(join(source, '.git', 'config'), 'utf8')).toBe(originalConfig);
    } finally {
      events.close();
    }
  },
  120_000,
);

import { afterEach, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as runner from '../sandboxed-command.js';
import { captureLocalRepositoryReader } from '../local-repository-native-reader.js';
import { repositoryObservationProgram } from '../native-repository-observation.js';
import type { NativeBaseReadScope } from '../codex-conversation.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
it.skipIf(process.platform !== 'darwin')(
  'binds physical base witnesses to the exact original factory scope across reader disposal',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-base-witness-owner-')));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', root]);
    // This unit transport exercises the fixed program; the registered mechanical
    // matrix separately qualifies its real OS boundary. No account or model exists.
    const transport = vi
      .spyOn(runner, 'executePrivateRepositoryObservation')
      .mockImplementation(async (options) => {
        const pending = promisify(execFile)(
          '/usr/bin/python3',
          ['-I', '-c', repositoryObservationProgram],
          {
            env: { PATH: '/usr/bin:/bin' },
            signal: options.signal,
            maxBuffer: options.maxOutputBytes,
          },
        );
        pending.child.stdin?.end(options.requestJson);
        return { content: '', stdout: (await pending).stdout, stderr: '', isError: false };
      });
    const owner = new AbortController(),
      current = vi.fn(() => owner.signal.throwIfAborted());
    const scope = Object.freeze({
      readableRoots: Object.freeze(['/']),
      workspaceRoots: Object.freeze([root]),
      deniedRoots: Object.freeze([]),
    }) as unknown as NativeBaseReadScope;
    const reader = async (selected = scope) => {
      const held = await captureLocalRepositoryReader(
        selected,
        owner.signal,
        current,
        async () => current(),
        { deadline: Date.now() + 30000 },
      );
      cleanup.push(() => held.dispose());
      return held;
    };
    const initial = await reader(),
      capture = await initial.captureRepositoryObservation!({ mode: 'base', sourcePath: root });
    await initial.dispose();
    await mkdir(join(root, '.git', 'worktrees'));
    await writeFile(join(root, '.git', 'refs', 'heads', 'unrelated'), 'a'.repeat(40) + '\n');
    const next = await reader();
    await next.verifyRepositoryBaseObservation!(capture);
    const calls = transport.mock.calls.length;
    await expect(
      next.verifyRepositoryBaseObservation!(Object.freeze({ ...capture })),
    ).rejects.toThrow();
    const borrowed = await reader(Object.freeze({ ...scope }));
    await expect(borrowed.verifyRepositoryBaseObservation!(capture)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(calls);
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/changed\n');
    await expect(next.verifyRepositoryBaseObservation!(capture)).rejects.toThrow();
    owner.abort(Error('Revoked original owner'));
    const after = transport.mock.calls.length;
    await expect(next.verifyRepositoryBaseObservation!(capture)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(after);
  },
);

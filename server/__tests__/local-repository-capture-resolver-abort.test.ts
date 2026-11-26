import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A cold macOS developer-Git lookup that has not finished yet.
const lookup = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../read-only-git.js', () => ({
  readOnlyGitExecutable: () => 'git',
  readOnlyGitExecutableAsync: () => {
    lookup.calls++;
    return new Promise<string>(() => {});
  },
}));
const spawned = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((...args: Parameters<typeof actual.execFile>) => {
      spawned.calls++;
      return actual.execFile(...args);
    }),
  };
});

import { captureLocalRepository } from '../local-repository-worktree.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function directory() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'capture-resolver-')));
  roots.push(root);
  return root;
}

it('settles Stop during a pending developer Git lookup without spawning a probe', async () => {
  const controller = new AbortController();
  const capture = captureLocalRepository('primary', directory(), controller.signal, 'HEAD');
  const reason = new Error('Stopped by the operator');
  controller.abort(reason);
  await expect(capture).rejects.toBe(reason);
  expect(lookup.calls).toBe(1);
  expect(spawned.calls).toBe(0);
});

it('applies the per-probe deadline to a pending developer Git lookup', async () => {
  vi.useFakeTimers();
  const capture = captureLocalRepository(
    'primary',
    directory(),
    new AbortController().signal,
    'HEAD',
  );
  const settled = expect(capture).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(5_000);
  await settled;
  expect(spawned.calls).toBe(0);
});

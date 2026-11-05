import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { hasUncommittedWorkAsync } from '../worktree.js';
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn((_file, _args, _options, done) => done(Error('Unexpected Git child'))),
}));
const root = mkdtempSync(join(tmpdir(), 'status-targets-'));
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
it('does not launch Git for a missing sandbox directory or an ordinary non-repository directory', async () => {
  await hasUncommittedWorkAsync(join(root, 'missing'));
  await hasUncommittedWorkAsync(root);
  expect(execFile).not.toHaveBeenCalled();
});

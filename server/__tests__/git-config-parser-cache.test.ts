import { expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { parseReadOnlyGitConfig } from '../read-only-git-config.js';
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
it('shares parsing only for identical bytes, including concurrent admissions', async () => {
  const bytes = Buffer.from('[core]\nrepositoryformatversion = 0\n');
  const [first, second] = await Promise.all([
    parseReadOnlyGitConfig(bytes),
    parseReadOnlyGitConfig(bytes),
  ]);
  expect(first).toEqual(second);
  expect(execFile).toHaveBeenCalledTimes(1);
  first.length = 0;
  expect(await parseReadOnlyGitConfig(bytes)).toContain('core.repositoryformatversion\n0');
  expect(
    await parseReadOnlyGitConfig(Buffer.from('[core]\nrepositoryformatversion = 1\n')),
  ).toContain('core.repositoryformatversion\n1');
  expect(execFile).toHaveBeenCalledTimes(2);
});

import { expect, it } from 'vitest';
import { repositoryNameFromCwd } from '../repository-name.js';

it.each([
  ['/workspace/mitzo/', 'mitzo'],
  ['/workspace/mgmt/.claude/worktrees/abc123', 'mgmt'],
  ['/workspace/mgmt/.cursor/worktrees/abc123/nested', 'mgmt'],
  [String.raw`C:\workspace\mgmt\.claude\worktrees\abc123`, 'mgmt'],
  ['C:\\workspace\\mitzo\\', 'mitzo'],
  ['/repository-tasks/repo-abc123', 'repo-abc123'],
  ['/', 'unknown'],
])('projects repository name from %s', (cwd, expected) => {
  expect(repositoryNameFromCwd(cwd)).toBe(expected);
});

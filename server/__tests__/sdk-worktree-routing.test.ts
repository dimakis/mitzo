import { expect, it, vi } from 'vitest';
import {
  REPOSITORY_TASK_CLONE_HINT,
  sdkWorktreePermissionOptions,
} from '../sdk-worktree-routing.js';

it('never redirects an OS-sandboxed ordinary SDK chat to an unwritable on-demand worktree', () => {
  const createOnDemand = vi.fn(() => async () => null);
  expect(
    sdkWorktreePermissionOptions({
      repositoryWorkspace: false,
      ordinarySdk: true,
      osSandboxed: true,
      createOnDemand,
    }),
  ).toEqual({ outOfRootHint: REPOSITORY_TASK_CLONE_HINT });
  expect(createOnDemand).not.toHaveBeenCalled();
  expect(REPOSITORY_TASK_CLONE_HINT).toContain('gh repo clone OWNER/REPO .repository-tasks/<name>');
});

it('keeps on-demand creation where the launch can write it, and none for repository tasks', () => {
  const created = async () => null;
  const createOnDemand = vi.fn(() => created);
  for (const route of [
    { repositoryWorkspace: false, ordinarySdk: true, osSandboxed: false },
    { repositoryWorkspace: false, ordinarySdk: false, osSandboxed: true },
    { repositoryWorkspace: true, ordinarySdk: true, osSandboxed: false },
  ])
    expect(sdkWorktreePermissionOptions({ ...route, createOnDemand })).toEqual({
      onDemandCreate: created,
    });
  expect(
    sdkWorktreePermissionOptions({
      repositoryWorkspace: true,
      ordinarySdk: false,
      osSandboxed: false,
      createOnDemand,
    }),
  ).toEqual({});
});

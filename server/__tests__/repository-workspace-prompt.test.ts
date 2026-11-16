import { expect, it } from 'vitest';
import { repositoryWorkspacePrompt } from '../repository-workspace-prompt.js';

it('describes retained linked Git storage and the supported scoped commit path', () => {
  const text = repositoryWorkspacePrompt('/task', { taskIdentity: { linkedGit: {} } as never });
  expect(text).toContain('linked worktree with shared Git storage');
  expect(text).toContain('TaskExecution with operation commit');
  expect(text).not.toContain('independent checkout');
});
it('only calls a checkout independent when its retained identity establishes that layout', () => {
  expect(repositoryWorkspacePrompt('/task', { taskIdentity: {} as never })).toContain(
    'independent checkout',
  );
  expect(repositoryWorkspacePrompt('/task', {})).not.toContain('independent checkout');
});

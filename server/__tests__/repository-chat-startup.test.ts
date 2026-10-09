import { expect, it, vi } from 'vitest';
import type { AccountBinding } from '@mitzo/protocol';
import {
  selectRepositoryChatWorkspace,
  repositoryChatContext,
} from '../repository-chat-startup.js';
const binding = { accountId: 'account', model: 'offline', provider: 'openai' } as AccountBinding;
it('claims only the initial conversation, supplies a trusted seed and binds context to the preparation', async () => {
  const claim = vi.fn(async () => ({
    id: 'workspace',
    repository: 'example/repo',
    baseBranch: 'main',
    baseOid: 'a'.repeat(40),
    featureBranch: 'mitzo/task',
    seed: '/private/source/mgmt',
  }));
  const deps = { getForConversation: vi.fn(() => undefined), claim };
  const source = await selectRepositoryChatWorkspace(
    {
      repositoryWorkspaceId: 'workspace',
      conversationId: 'conversation',
      binding,
      sandbox: true,
      taskRoot: '/tasks',
    },
    deps,
  );
  expect(claim).toHaveBeenCalledWith('workspace', binding, 'conversation', '/tasks', true);
  expect(source?.seed).toBe('/private/source/mgmt');
  expect(repositoryChatContext(source)).toContain('workspace');
  expect(repositoryChatContext(source)).toContain('a'.repeat(40));
  await expect(
    selectRepositoryChatWorkspace(
      {
        repositoryWorkspaceId: 'workspace',
        conversationId: 'conversation',
        resume: true,
        binding,
        sandbox: true,
        taskRoot: '/tasks',
      },
      deps,
    ),
  ).rejects.toThrow();
  expect(claim).toHaveBeenCalledOnce();
});
it('preserves existing conversation metadata on resume without recloning or reverting task changes', async () => {
  const record = {
    id: 'workspace',
    repository: 'example/repo',
    baseBranch: 'main',
    baseOid: 'a'.repeat(40),
    featureBranch: 'mitzo/task',
    directory: '/tasks/current',
    state: 'claimed',
    conversationId: 'conversation',
  };
  const deps = { getForConversation: vi.fn(() => record), claim: vi.fn() };
  expect(
    await selectRepositoryChatWorkspace(
      { conversationId: 'conversation', resume: true, binding, sandbox: false, taskRoot: '/tasks' },
      deps,
    ),
  ).toEqual(record);
  expect(deps.claim).not.toHaveBeenCalled();
  expect(
    await selectRepositoryChatWorkspace(
      { conversationId: 'new', binding, sandbox: false, taskRoot: '/tasks' },
      { ...deps, getForConversation: () => undefined },
    ),
  ).toBeUndefined();
});

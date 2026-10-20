import { expect, it } from 'vitest';
import { conversationRepositoryLabel } from '../conversation-repository-label';

const input = {
  conversationId: 'current-chat',
  routeConversationId: 'current-chat',
  metadataPending: false,
  repoNames: ['legacy-repository'],
};

it('uses the existing public runtime projection ahead of legacy labels', () => {
  expect(
    conversationRepositoryLabel({
      ...input,
      repositoryWorkspaceId: 'workspace',
      repositoryContext: { workspaceId: 'workspace', repository: 'example/current-repository' },
    }),
  ).toBe('example/current-repository');
});

it('keeps a known workspace unavailable when its optional projection is missing', () => {
  expect(conversationRepositoryLabel({ ...input, repositoryWorkspaceId: 'workspace' })).toBe(
    'Unavailable',
  );
});

it('suppresses every repository label when the selected route and conversation differ', () => {
  expect(
    conversationRepositoryLabel({
      ...input,
      routeConversationId: 'other-chat',
      repositoryWorkspaceId: 'workspace',
      repositoryContext: { workspaceId: 'workspace', repository: 'example/current-repository' },
    }),
  ).toBeUndefined();
});

it('retains only actual bounded legacy names, deduplicating without deriving a repository', () => {
  expect(
    conversationRepositoryLabel({
      ...input,
      repoNames: [
        'legacy-repository',
        'legacy-repository',
        'example/second',
        '/private/task',
        'C:\\private',
        '../parent',
        'r'.repeat(201),
      ],
    }),
  ).toBe('legacy-repository, example/second');
});

it('withholds legacy names while metadata is pending and leaves unknown repositories absent', () => {
  expect(conversationRepositoryLabel({ ...input, metadataPending: true })).toBeUndefined();
  expect(conversationRepositoryLabel({ ...input, repoNames: [] })).toBeUndefined();
});

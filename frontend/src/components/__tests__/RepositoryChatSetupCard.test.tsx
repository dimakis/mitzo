// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RepositoryChatSetupCard } from '../RepositoryChatSetupCard';
import { ToolGroup } from '../ToolGroup';

const preparation = {
  id: '8ca30b0d-3e65-4eeb-8244-f6277350818f',
  sourceConversationId: 'parent-chat',
  repository: 'example/repo',
  baseBranch: 'main',
  baseOid: 'a'.repeat(40),
  featureBranch: 'mitzo/task',
  state: 'ready',
  accountId: 'work',
  model: 'luna',
  prompt: 'Fix the failing repository test.',
  setupUrl: '/chat?repositoryPreparation=8ca30b0d-3e65-4eeb-8244-f6277350818f',
};
const block = {
  blockId: 'repo-ready',
  blockType: 'tool_use' as const,
  content: '',
  done: true,
  toolName: 'mcp__mitzo-connections__PrepareRepositoryChat',
  toolResult: JSON.stringify({ repositoryChat: preparation }),
};
afterEach(cleanup);
it('offers a reviewed repository draft without starting a conversation', () => {
  render(
    <MemoryRouter>
      <RepositoryChatSetupCard block={block} sessionId="parent-chat" />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Open repository chat' }).getAttribute('href')).toBe(
    preparation.setupUrl,
  );
  expect(screen.getByText('example/repo')).toBeTruthy();
  expect(screen.getByText('aaaaaaaaaaaa')).toBeTruthy();
  expect(screen.getByText(preparation.prompt)).toBeTruthy();
});
it.each([
  { ...block, toolName: 'Read' },
  { ...block, toolResult: 'invalid' },
  {
    ...block,
    toolResult: JSON.stringify({
      repositoryChat: { ...preparation, sourceConversationId: 'other' },
    }),
  },
  {
    ...block,
    toolResult: JSON.stringify({
      repositoryChat: { ...preparation, setupUrl: 'https://evil.invalid/chat' },
    }),
  },
  { ...block, toolResult: JSON.stringify({ repositoryChat: { ...preparation, extra: true } }) },
])('does not present untrusted or unrelated repository actions', (bad) => {
  render(
    <MemoryRouter>
      <RepositoryChatSetupCard block={bad} sessionId="parent-chat" />
    </MemoryRouter>,
  );
  expect(screen.queryByRole('link')).toBeNull();
});
it('keeps only the latest preparation card visible in a collapsed tool group', () => {
  render(
    <MemoryRouter>
      <ToolGroup
        tools={[block, { ...block, blockId: 'status', toolName: 'GetRepositoryChatPreparation' }]}
        sessionId="parent-chat"
      />
    </MemoryRouter>,
  );
  expect(screen.getAllByRole('link', { name: 'Open repository chat' })).toHaveLength(1);
});
it('links a claimed preparation only to its original conversation', () => {
  render(
    <MemoryRouter>
      <RepositoryChatSetupCard
        block={{
          ...block,
          toolResult: JSON.stringify({
            repositoryChat: { ...preparation, state: 'claimed', conversationId: 'settled' },
          }),
        }}
        sessionId="parent-chat"
      />
    </MemoryRouter>,
  );
  expect(screen.queryByRole('link', { name: 'Open repository chat' })).toBeNull();
  expect(
    screen.getByRole('link', { name: 'Open repository conversation' }).getAttribute('href'),
  ).toBe('/chat/settled');
});

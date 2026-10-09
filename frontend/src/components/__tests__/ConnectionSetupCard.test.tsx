// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import { ConnectionSetupCard } from '../ConnectionSetupCard';
import { ToolGroup } from '../ToolGroup';
const setup = {
  id: 'draft-a',
  sessionId: 'chat-a',
  revision: 1,
  status: 'pending',
  expiresAt: Date.now() + 60_000,
  setupUrl: '/connections/setup/draft-a',
  connection: { label: 'Home Assistant', endpoint: 'https://ha.example.com' },
  credential: { label: 'Home Assistant key' },
  profile: 'home-assistant',
};
const block = {
  blockId: 'block-a',
  blockType: 'tool_use' as const,
  content: '',
  done: true,
  toolName: 'mcp__mitzo-connections__PrepareConnectionSetup',
  toolResult: JSON.stringify({ setup }),
};
afterEach(cleanup);
it('renders the prepared credential action without protocol configuration', () => {
  render(
    <MemoryRouter>
      <ConnectionSetupCard block={block} sessionId="chat-a" />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Add Home Assistant key' }).getAttribute('href')).toBe(
    '/connections/setup/draft-a',
  );
});
it.each([
  { ...block, toolName: 'Read' },
  {
    ...block,
    toolResult: JSON.stringify({ setup: { ...setup, setupUrl: 'https://evil.example/key' } }),
  },
  { ...block, toolResult: JSON.stringify({ setup: { ...setup, sessionId: 'other-chat' } }) },
  { ...block, toolResult: 'invalid' },
])('rejects an untrusted or unrelated setup action', (bad) => {
  render(
    <MemoryRouter>
      <ConnectionSetupCard block={bad} sessionId="chat-a" />
    </MemoryRouter>,
  );
  expect(screen.queryByRole('link')).toBeNull();
});
it('keeps the secure setup action visible when tool operations are collapsed', () => {
  render(
    <MemoryRouter>
      <ToolGroup
        tools={[block, { ...block, blockId: 'block-b', toolName: 'Read', toolResult: 'read done' }]}
        sessionId="chat-a"
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Add Home Assistant key' })).toBeTruthy();
});

// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatArea } from '../ChatArea';
import type { FinishedMessage, StreamingBlock } from '../../types/chat';

afterEach(cleanup);
const base = { running: false, permission: null, onPermissionRespond: () => {} };
const thought = {
  blockId: 'thought',
  blockType: 'thinking' as const,
  content: 'Checking the records',
};
const tool = {
  blockId: 'tool',
  blockType: 'tool_use' as const,
  content: '',
  toolId: 'tool',
  toolName: 'Read',
  toolInput: '/workspace/report.md',
  toolResult: 'Report contents',
};
const messages: FinishedMessage[] = [
  {
    messageId: 'before',
    role: 'assistant',
    blocks: [{ blockId: 'before', blockType: 'text', content: 'I will check.' }],
  },
  { messageId: 'thinking', role: 'assistant', blocks: [thought] },
  { messageId: 'tool', role: 'assistant', blocks: [tool] },
  {
    messageId: 'after',
    role: 'assistant',
    blocks: [{ blockId: 'after', blockType: 'text', content: 'Here is the answer.' }],
  },
];

it('collapses mixed activity across provider messages between visible responses and reveals every detail', () => {
  render(
    <MemoryRouter>
      <ChatArea {...base} messages={messages} current={null} />
    </MemoryRouter>,
  );
  const toggle = screen.getByRole('button', { name: /Agent at work/ });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.textContent).toContain('Read');
  expect(toggle.textContent).toContain('/workspace/report.md');
  expect(screen.getByText('I will check.')).toBeTruthy();
  expect(screen.getByText('Here is the answer.')).toBeTruthy();
  expect(screen.queryByText('Thought')).toBeNull();
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('button', { name: /Thought/ }));
  expect(screen.getByText('Checking the records')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^Read/ }));
  expect(screen.getByText('Report contents')).toBeTruthy();
  fireEvent.click(toggle);
  expect(screen.queryByText('Report contents')).toBeNull();
});

it('keeps the disclosure open through streaming updates and completion with the latest thought preview', () => {
  const current = {
    messageId: 'live',
    blockOrder: ['tool'],
    blocks: new Map<string, StreamingBlock>([
      ['tool', { ...tool, toolResult: undefined, done: false }],
    ]),
  };
  const { rerender } = render(
    <MemoryRouter>
      <ChatArea {...base} messages={[]} current={current} running />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Agent at work/ }));
  const next = {
    ...current,
    blockOrder: ['tool', 'thought'],
    blocks: new Map<string, StreamingBlock>([
      ['tool', { ...tool, done: true }],
      ['thought', { ...thought, done: false }],
    ]),
  };
  rerender(
    <MemoryRouter>
      <ChatArea {...base} messages={[]} current={next} running />
    </MemoryRouter>,
  );
  expect(screen.getByRole('button', { name: /Agent at work/ }).textContent).toContain(
    'Checking the records',
  );
  rerender(
    <MemoryRouter>
      <ChatArea
        {...base}
        messages={[{ messageId: 'live', role: 'assistant', blocks: [tool, thought] }]}
        current={null}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('button', { name: /Agent at work/ }).getAttribute('aria-expanded')).toBe(
    'true',
  );
});

it('keeps failed calls visible in the collapsed summary and does not merge across user messages', () => {
  render(
    <MemoryRouter>
      <ChatArea
        {...base}
        current={null}
        messages={[
          {
            messageId: 'failed',
            role: 'assistant',
            blocks: [{ ...tool, toolError: true }, thought],
          },
          {
            messageId: 'user',
            role: 'user',
            blocks: [{ blockId: 'user', blockType: 'text', content: 'Try again' }],
          },
          { messageId: 'retry', role: 'assistant', blocks: [{ ...tool, blockId: 'retry' }] },
        ]}
      />
    </MemoryRouter>,
  );
  const toggles = screen.getAllByRole('button', { name: /Agent at work/ });
  expect(toggles).toHaveLength(2);
  expect(toggles[0].textContent).toContain('1 failed');
});

it.each([
  ['claude', 'personal-claude', 'Bash'],
  ['openai-codex', 'personal-subscription', 'exec_command'],
  ['openai-codex', 'work-subscription', 'functions.exec'],
  ['openai', 'work-api', 'Read'],
  ['vertex', 'work-vertex', 'run_shell_command'],
  ['custom-rest', 'custom-account', 'custom_tool'],
])(
  'groups normalized %s activity for account %s without a tool-name allowlist',
  (_provider, accountId, toolName) => {
    render(
      <MemoryRouter>
        <ChatArea
          {...base}
          sessionId={accountId}
          current={null}
          messages={[
            {
              messageId: 'a',
              role: 'assistant',
              blocks: [
                thought,
                { ...tool, toolName },
                { blockId: 'redacted', blockType: 'redacted_thinking', content: '' },
              ],
            },
          ]}
        />
      </MemoryRouter>,
    );
    const toggle = screen.getByRole('button', { name: /Agent at work/ });
    expect(toggle.textContent).toContain('Reasoning redacted');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: new RegExp(`^${toolName}`) })).toBeTruthy();
  },
);

it('isolates concurrent seats with colliding provider block IDs and keeps identity visible when collapsed', () => {
  const provenance = (seatId: string) => ({
    seatId,
    membershipGeneration: 1,
    configRevision: 1,
    accountProfileRevision: 'a',
    seatProfileRevision: 'p',
    contextGrantRevision: 1,
    authorityGrantRevision: 1,
    isolationDomainId: 'shared',
    isolationDomainRevision: 1,
  });
  render(
    <MemoryRouter>
      <ChatArea
        {...base}
        messages={[]}
        current={null}
        currentByMessage={{
          first: {
            messageId: 'same',
            startedSeq: 1,
            symposiumProvenance: provenance('builder'),
            blockOrder: ['tool'],
            blocks: new Map([['tool', { ...tool, done: false }]]),
          },
          second: {
            messageId: 'same',
            startedSeq: 2,
            symposiumProvenance: provenance('reviewer'),
            blockOrder: ['tool'],
            blocks: new Map([['tool', { ...tool, done: false }]]),
          },
        }}
      />
    </MemoryRouter>,
  );
  const toggles = screen.getAllByRole('button', { name: /Agent at work/ });
  expect(toggles).toHaveLength(2);
  expect(screen.getByText(/Builder seat/)).toBeTruthy();
  expect(screen.getByText(/Reviewer seat/)).toBeTruthy();
  fireEvent.click(toggles[0]);
  expect(toggles[1].getAttribute('aria-expanded')).toBe('false');
});

it('keeps prepared connection setup visible and deduplicated outside collapsed activity', () => {
  const setup = {
    id: 'setup',
    sessionId: 'chat',
    status: 'pending',
    expiresAt: Date.now() + 60_000,
    setupUrl: '/connections/setup/setup',
    connection: { label: 'Home Assistant' },
    credential: { label: 'Home Assistant key' },
  };
  const setupBlock = {
    ...tool,
    toolName: 'PrepareConnectionSetup',
    toolResult: JSON.stringify({ setup }),
  };
  render(
    <MemoryRouter>
      <ChatArea
        {...base}
        sessionId="chat"
        current={null}
        messages={[
          {
            messageId: 'a',
            role: 'assistant',
            blocks: [setupBlock, thought, { ...setupBlock, blockId: 'latest' }],
          },
        ]}
      />
    </MemoryRouter>,
  );
  expect(screen.getAllByRole('link', { name: 'Add Home Assistant key' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /Agent at work/ }));
  expect(screen.getAllByRole('link', { name: 'Add Home Assistant key' })).toHaveLength(1);
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatArea } from '../ChatArea';
import { ReplyQuote } from '../ReplyQuote';
vi.mock('../MessageBubble', () => ({
  UserBubble: ({ text }: { text?: string }) => <p>{text}</p>,
  TextBubble: ({ content }: { content: string }) => <p>{content}</p>,
}));

afterEach(cleanup);
it('uses the composer quote to navigate only its own conversation and return focus', () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  render(
    <>
      <ChatArea
        sessionId="current"
        messages={[
          {
            messageId: 'old',
            role: 'assistant',
            blocks: [{ blockId: 'old-text', blockType: 'text', content: 'Original' }],
          },
        ]}
        current={null}
        running={false}
        permission={null}
        onPermissionRespond={vi.fn()}
      />
      <ReplyQuote
        sessionId="other"
        reply={{ messageId: 'old', role: 'assistant', text: 'Other chat selection' }}
      />
      <ReplyQuote
        sessionId="current"
        reply={{ messageId: 'old', role: 'assistant', text: 'Current selection' }}
      />
    </>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Replying to: Other chat selection' }));
  expect(screen.queryByRole('button', { name: 'Back to reply' })).toBeNull();
  const opener = screen.getByRole('button', { name: 'Replying to: Current selection' });
  fireEvent.click(opener);
  expect(document.activeElement?.getAttribute('data-reply-source')).toBe('old');
  expect(document.activeElement?.classList.contains('chat-reply-target')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Back to reply' }));
  expect(document.activeElement).toBe(opener);
});
it('quotes an exact earlier assistant message and returns from its source', () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const messages = [
    {
      messageId: 'old',
      role: 'assistant' as const,
      timestamp: 1793925200000,
      blocks: [
        { blockId: 'old-text', blockType: 'text' as const, content: 'Keep the recovery isolated.' },
      ],
    },
    {
      messageId: 'new',
      role: 'assistant' as const,
      replyToMessageId: 'old',
      blocks: [
        { blockId: 'new-text', blockType: 'text' as const, content: 'The recovery is isolated.' },
      ],
    },
  ];
  render(
    <ChatArea
      messages={messages}
      current={null}
      running={false}
      permission={null}
      onPermissionRespond={vi.fn()}
    />,
  );
  const quote = screen.getByRole('button', { name: 'Replying to: Keep the recovery isolated.' });
  expect(quote.textContent).toContain('Mitzo');
  expect(quote.querySelector('time')).toBeTruthy();
  fireEvent.click(quote);
  expect(document.activeElement?.getAttribute('data-reply-source')).toBe('old');
  fireEvent.click(screen.getByRole('button', { name: 'Back to reply' }));
  expect(document.activeElement).toBe(quote);
});
it('identifies an unavailable source without guessing a nearby message', () => {
  render(
    <ChatArea
      messages={[
        {
          messageId: 'new',
          role: 'assistant',
          replyToMessageId: 'missing',
          blocks: [{ blockId: 'new-text', blockType: 'text', content: 'Response' }],
        },
      ]}
      current={null}
      running={false}
      permission={null}
      onPermissionRespond={vi.fn()}
    />,
  );
  expect(screen.getByText('Original message unavailable')).toBeTruthy();
  expect(screen.queryByText('Answering an earlier message')).toBeNull();
});

it('places a launch receipt before later conversation instead of pinning it at the composer', () => {
  const { container } = render(
    <ChatArea
      messages={[
        {
          messageId: 'later',
          role: 'assistant',
          timestamp: 2000,
          blocks: [{ blockId: 'later-text', blockType: 'text', content: 'We can continue here.' }],
        },
      ]}
      current={null}
      running={false}
      permission={null}
      onPermissionRespond={vi.fn()}
      launchRequests={[
        {
          proposalId: 'proposal',
          requestId: 'request',
          sourceSessionId: 'source',
          title: 'Child chat',
          prompt: 'Handoff',
          revision: 1,
          state: 'cancelled',
          childSessionId: null,
          createdAt: 1000,
          updatedAt: 1000,
          configuration: {
            version: 1,
            runtime: {
              version: 1,
              account: null,
              agentProfile: null,
              execution: { location: 'local', targetId: null },
            },
            mode: 'ask',
            isolation: true,
            repositoryWorkspaceId: null,
            contextBlocks: [],
            extraTools: [],
          },
        },
      ]}
    />,
  );
  const receipt = screen.getByText('Child chat');
  expect(
    receipt.compareDocumentPosition(screen.getByText('We can continue here.')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(container.querySelector('.chat-messages .session-launch-card')).toBeTruthy();
});

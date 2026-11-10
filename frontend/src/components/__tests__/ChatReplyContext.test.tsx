// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatArea } from '../ChatArea';
vi.mock('../MessageBubble', () => ({
  UserBubble: ({ text }: { text?: string }) => <p>{text}</p>,
  TextBubble: ({ content }: { content: string }) => <p>{content}</p>,
}));

afterEach(cleanup);
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

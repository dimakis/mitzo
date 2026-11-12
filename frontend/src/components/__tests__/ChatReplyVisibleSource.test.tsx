// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatArea } from '../ChatArea';
import { MemoryRouter } from 'react-router-dom';
vi.mock('../MessageBubble', () => ({
  UserBubble: ({ text }: { text?: string }) => <p>{text}</p>,
  TextBubble: ({ content }: { content: string }) => <p>{content}</p>,
}));

afterEach(cleanup);
it.each(['thinking', 'tool_use'] as const)(
  'navigates to visible source text after expanded %s and returns to the reply',
  (blockType) => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const messages = [
      {
        messageId: 'old',
        role: 'assistant' as const,
        timestamp: 1793925200000,
        blocks: [
          {
            blockId: 'activity',
            blockType,
            content: 'Earlier activity',
            toolName: 'Read',
            toolId: 'read',
            toolInput: 'fixture',
            toolResult: 'done',
          },
          {
            blockId: 'old-text',
            blockType: 'text' as const,
            content: 'Keep the recovery isolated.',
          },
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
      { wrapper: MemoryRouter },
    );
    const quote = screen.getByRole('button', { name: 'Replying to: Keep the recovery isolated.' });
    fireEvent.click(screen.getByRole('button', { name: /^Activity:/ }));
    expect(quote.textContent).toContain('Mitzo');
    expect(quote.querySelector('time')).toBeTruthy();
    fireEvent.click(quote);
    expect(document.activeElement?.getAttribute('data-reply-source')).toBe('old');
    expect(document.activeElement?.textContent).toContain('Keep the recovery isolated.');
    expect(document.activeElement?.closest('.agent-activity')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to reply' }));
    expect(document.activeElement).toBe(quote);
  },
);

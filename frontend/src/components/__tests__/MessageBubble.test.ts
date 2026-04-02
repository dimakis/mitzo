import { describe, it, expect, vi } from 'vitest';

// Mock react-markdown and remark-gfm before importing the component
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => children,
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBubble } from '../MessageBubble';
import type { FinishedMessage } from '../../types/chat';

function userMessage(text: string): FinishedMessage {
  return {
    messageId: 'test-msg',
    role: 'user',
    blocks: [{ blockId: 'b1', blockType: 'text', content: text }],
  };
}

describe('MessageBubble', () => {
  it('renders user message with msg-bubble-content class', () => {
    const html = renderToStaticMarkup(
      createElement(MessageBubble, { message: userMessage('hello\nworld') }),
    );
    expect(html).toContain('msg-bubble-content');
    expect(html).toContain('hello\nworld');
  });

  it('preserves newlines in user message text', () => {
    const html = renderToStaticMarkup(
      createElement(MessageBubble, {
        message: userMessage('line one\nline two\nline three'),
      }),
    );
    // The raw text should contain newlines (CSS white-space: pre-wrap handles display)
    expect(html).toContain('line one\nline two\nline three');
  });
});

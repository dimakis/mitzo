import { describe, it, expect, vi } from 'vitest';

// Mock react-markdown and remark-gfm before importing the component
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let capturedComponents: Record<string, any> | undefined;
vi.mock('react-markdown', () => ({
  default: ({
    children,
    components,
  }: {
    children: string;
    components?: Record<string, unknown>;
  }) => {
    capturedComponents = components;
    return children;
  },
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBubble, TextBubble } from '../MessageBubble';
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

  it('passes table scroll wrapper component to ReactMarkdown', () => {
    renderToStaticMarkup(createElement(TextBubble, { content: 'test' }));
    expect(capturedComponents).toBeDefined();
    expect(capturedComponents!.table).toBeDefined();

    // Render the custom table component and verify wrapper
    const tableHtml = renderToStaticMarkup(
      capturedComponents!.table({ children: createElement('tr', null, 'row') }),
    );
    expect(tableHtml).toContain('table-scroll-wrapper');
    expect(tableHtml).toContain('<table');
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

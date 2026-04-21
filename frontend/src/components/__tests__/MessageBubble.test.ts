import { describe, it, expect, vi } from 'vitest';

// Mock react-markdown and remark-gfm before importing the component
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let capturedComponents: Record<string, any> | undefined;
let capturedContent: string | undefined;
vi.mock('react-markdown', () => ({
  default: ({
    children,
    components,
  }: {
    children: string;
    components?: Record<string, unknown>;
  }) => {
    capturedComponents = components;
    capturedContent = children;
    return children;
  },
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: '/chat/test-session', search: '' }),
}));

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBubble, TextBubble, UserBubble } from '../MessageBubble';
import { FILE_SCHEME } from '../../lib/file-paths';
import type { FinishedMessage } from '../../types/chat';

function userMessage(text: string, timestamp?: number): FinishedMessage {
  return {
    messageId: 'test-msg',
    role: 'user',
    timestamp,
    blocks: [{ blockId: 'b1', blockType: 'text', content: text }],
  };
}

function assistantMessage(text: string, timestamp?: number): FinishedMessage {
  return {
    messageId: 'test-msg-assistant',
    role: 'assistant',
    timestamp,
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

  it('linkifies file paths in assistant content', () => {
    renderToStaticMarkup(createElement(TextBubble, { content: 'Created /tmp/output.md for you.' }));
    expect(capturedContent).toContain(`[/tmp/output.md](${FILE_SCHEME}`);
  });

  it('does not linkify while streaming', () => {
    renderToStaticMarkup(
      createElement(TextBubble, { content: 'Created /tmp/output.md for you.', streaming: true }),
    );
    expect(capturedContent).not.toContain(FILE_SCHEME);
    expect(capturedContent).toBe('Created /tmp/output.md for you.');
  });

  it('provides a custom anchor component for file-path links', () => {
    renderToStaticMarkup(createElement(TextBubble, { content: 'test' }));
    expect(capturedComponents).toBeDefined();
    expect(capturedComponents!.a).toBeDefined();
  });

  it('custom anchor navigates to FileViewer for file-path links', () => {
    mockNavigate.mockClear();
    renderToStaticMarkup(createElement(TextBubble, { content: 'test' }));

    const anchor = capturedComponents!.a;
    const fileHref = `${FILE_SCHEME}${encodeURIComponent('/tmp/output.md')}`;
    const el = createElement(anchor, { href: fileHref, children: '/tmp/output.md' });
    const html = renderToStaticMarkup(el);

    expect(html).toContain('file-path-link');

    // Simulate click to verify navigate is called with the correct route
    const clickEvent = { preventDefault: vi.fn() };
    // Extract onClick from rendered component — render via createElement to get props
    const rendered = anchor({ href: fileHref, children: '/tmp/output.md' });
    rendered.props.onClick(clickEvent);

    expect(clickEvent.preventDefault).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith(
      `/files?path=${encodeURIComponent('/tmp/output.md')}&from=${encodeURIComponent('/chat/test-session')}`,
    );
  });

  it('custom anchor renders normal links for non-file URLs', () => {
    renderToStaticMarkup(createElement(TextBubble, { content: 'test' }));
    const anchor = capturedComponents!.a;
    const el = createElement(anchor, {
      href: 'https://example.com',
      children: 'Example',
    });
    const html = renderToStaticMarkup(el);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('file-path-link');
  });
});

describe('UserBubble timestamp', () => {
  it('renders timestamp when provided', () => {
    const ts = new Date('2026-01-15T14:30:00').getTime();
    const html = renderToStaticMarkup(createElement(UserBubble, { text: 'hello', timestamp: ts }));
    expect(html).toContain('msg-timestamp');
    expect(html).toContain('msg-timestamp--user');
  });

  it('omits timestamp when not provided', () => {
    const html = renderToStaticMarkup(createElement(UserBubble, { text: 'hello' }));
    expect(html).not.toContain('msg-timestamp');
  });

  it('wraps bubble and timestamp in a container div', () => {
    const ts = Date.now();
    const html = renderToStaticMarkup(createElement(UserBubble, { text: 'hello', timestamp: ts }));
    expect(html).toContain('msg-bubble-group');
    expect(html).toContain('msg-bubble-group--user');
  });
});

describe('TextBubble timestamp', () => {
  it('renders timestamp in footer when provided', () => {
    const ts = new Date('2026-01-15T14:30:00').getTime();
    const html = renderToStaticMarkup(
      createElement(TextBubble, { content: 'hello', timestamp: ts }),
    );
    expect(html).toContain('msg-timestamp');
    expect(html).toContain('msg-bubble-footer');
  });

  it('omits timestamp span when not provided', () => {
    const html = renderToStaticMarkup(createElement(TextBubble, { content: 'hello' }));
    expect(html).not.toContain('msg-timestamp');
  });

  it('hides footer during streaming', () => {
    const ts = Date.now();
    const html = renderToStaticMarkup(
      createElement(TextBubble, { content: 'hello', streaming: true, timestamp: ts }),
    );
    expect(html).not.toContain('msg-bubble-footer');
  });
});

describe('TextBubble collapse', () => {
  it('does not render collapse toggle for short content', () => {
    const html = renderToStaticMarkup(createElement(TextBubble, { content: 'short' }));
    expect(html).not.toContain('msg-bubble-collapse-toggle');
    expect(html).not.toContain('Show more');
  });

  it('does not add collapsed class for short content', () => {
    const html = renderToStaticMarkup(createElement(TextBubble, { content: 'short' }));
    expect(html).not.toContain('msg-bubble--collapsed');
  });

  it('does not render collapse toggle while streaming', () => {
    const html = renderToStaticMarkup(
      createElement(TextBubble, { content: 'streaming content', streaming: true }),
    );
    expect(html).not.toContain('msg-bubble-collapse-toggle');
  });
});

describe('TextBubble code block CopyButton', () => {
  it('provides a custom pre component to ReactMarkdown', () => {
    renderToStaticMarkup(createElement(TextBubble, { content: '```\ncode\n```' }));
    expect(capturedComponents).toBeDefined();
    expect(capturedComponents!.pre).toBeDefined();
  });

  it('custom pre component wraps content with code-block-wrapper', () => {
    renderToStaticMarkup(createElement(TextBubble, { content: 'test' }));
    const pre = capturedComponents!.pre;
    const html = renderToStaticMarkup(
      pre({ children: createElement('code', null, 'const x = 1;') }),
    );
    expect(html).toContain('code-block-wrapper');
    expect(html).toContain('code-block-copy');
  });
});

describe('MessageBubble legacy adapter forwards timestamps', () => {
  it('forwards timestamp to UserBubble for user messages', () => {
    const ts = Date.now();
    const html = renderToStaticMarkup(
      createElement(MessageBubble, { message: userMessage('hello', ts) }),
    );
    expect(html).toContain('msg-timestamp');
  });

  it('forwards timestamp to TextBubble for assistant messages', () => {
    const ts = Date.now();
    const html = renderToStaticMarkup(
      createElement(MessageBubble, { message: assistantMessage('hello', ts) }),
    );
    expect(html).toContain('msg-timestamp');
  });

  it('renders without timestamp when message has none', () => {
    const html = renderToStaticMarkup(
      createElement(MessageBubble, { message: userMessage('hello') }),
    );
    expect(html).not.toContain('msg-timestamp');
  });
});

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
import { MessageBubble, TextBubble } from '../MessageBubble';
import { FILE_SCHEME } from '../../lib/file-paths';
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

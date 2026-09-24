// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { MessageBubble, TextBubble } from '../MessageBubble';
import type { FinishedMessage } from '../../types/chat';

function renderBubble(content: string, streaming = false): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/chat/test-session'] },
      createElement(TextBubble, { content, streaming }),
    ),
  );
}

describe('TextBubble file link rendering', () => {
  it.each(['report.html', 'outputs/report.html', './outputs/report.html'])(
    'opens relative Markdown artifact %s in the originating session',
    (path) => {
      function Location() {
        const location = useLocation();
        return <output data-testid="location">{location.pathname + location.search}</output>;
      }
      render(
        <MemoryRouter initialEntries={['/chat/test-session']}>
          <TextBubble content={`[report](${path})`} artifactSessionId="test-session" />
          <Location />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole('link', { name: 'report' }));
      const url = new URL(screen.getByTestId('location').textContent!, 'https://mitzo.test');
      expect(url.pathname).toBe('/files');
      expect(url.searchParams.get('path')).toBe(path);
      expect(url.searchParams.get('sessionId')).toBe('test-session');
      cleanup();
    },
  );

  it('keeps external and page-relative browser links outside artifact routing', () => {
    const html = renderBubble('[site](https://example.com) [section](#section)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="#section"');
    expect(html).not.toContain('file-path-link');
  });

  it.each([false, true])(
    'leaves a malformed encoded file link readable and inert when streaming=%s',
    (streaming) => {
      const html = renderBubble('[invalid](file-path://%E0%A4%A)', streaming);

      expect(html).toContain('invalid');
      expect(html).not.toContain('file-path-link');
      expect(html).not.toContain('file-path-share');
    },
  );

  it.each([false, true])(
    'leaves an incomplete percent escape readable and inert when streaming=%s',
    (streaming) => {
      const html = renderBubble('[incomplete](file-path://%2)', streaming);

      expect(html).toContain('incomplete');
      expect(html).not.toContain('file-path-link');
      expect(html).not.toContain('file-path-share');
    },
  );

  it.each(['[titled](file-path://%2 "title")', '[angled](<file-path://%2>)'])(
    'neutralizes malformed Markdown destination variants: %s',
    (content) => {
      const html = renderBubble(content);

      expect(html).toMatch(/titled|angled/);
      expect(html).not.toContain('file-path-link');
      expect(html).not.toContain('file-path-share');
    },
  );

  it.each([false, true])(
    'neutralizes a malformed reference-style file link when streaming=%s',
    (streaming) => {
      const html = renderBubble('[referenced][target]\n\n[target]: file-path://%2', streaming);

      expect(html).toContain('referenced');
      expect(html).not.toContain('file-path-link');
      expect(html).not.toContain('file-path-share');
    },
  );

  it('honors the first definition when duplicate reference definitions exist', () => {
    const html = renderBubble(
      '[external][target]\n\n[target]: https://example.com\n[target]: file-path://%2',
    );

    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('file-path-link');
  });

  it.each([
    '`[inline](file-path://%2)`',
    '````md\n[fenced](file-path://%2)\n````',
    '~~~md\n[tilde](file-path://%2)\n~~~',
    '    [indented](file-path://%2)',
  ])('leaves malformed-link text unchanged inside code: %s', (content) => {
    const html = renderBubble(content);

    expect(html).toContain('file-path://%2');
    expect(html).not.toContain('file-path-link');
    expect(html).not.toContain('file-path-share');
  });

  it.each([false, true])('retains valid file links when streaming=%s', (streaming) => {
    const html = renderBubble('[notes](file-path://%2Ftmp%2Fnotes.txt)', streaming);

    expect(html).toContain('file-path-link');
    expect(html).toContain('data-file-path="/tmp/notes.txt"');
    expect(html).toContain('file-path-share');
  });

  it.each([false, true])(
    'retains a valid file link containing a literal percent when streaming=%s',
    (streaming) => {
      const html = renderBubble('[report](file-path://%2Ftmp%2F100%25-done.txt)', streaming);

      expect(html).toContain('file-path-link');
      expect(html).toContain('data-file-path="/tmp/100%-done.txt"');
      expect(html).toContain('file-path-share');
    },
  );

  it('retains markdown preview promotion for a valid standalone markdown file link', () => {
    const html = renderBubble('[notes](file-path://%2Ftmp%2Fnotes.md)');

    expect(html).toContain('md-preview-card');
    expect(html).toContain('notes.md');
  });
});

describe('MessageBubble restored message rendering', () => {
  it('keeps a restored message with a malformed file link readable', () => {
    const message: FinishedMessage = {
      messageId: 'restored-message',
      role: 'assistant',
      blocks: [
        {
          blockId: 'text-block',
          blockType: 'text',
          content: 'Recovered [invalid](file-path://%E0%A4%A) message',
        },
      ],
    };

    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/chat/restored-session'] },
        createElement(MessageBubble, { message }),
      ),
    );

    expect(html).toContain('Recovered');
    expect(html).toContain('invalid');
    expect(html).toContain('message');
    expect(html).not.toContain('file-path-link');
  });
});

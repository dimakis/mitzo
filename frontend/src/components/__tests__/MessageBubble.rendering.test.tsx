import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
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

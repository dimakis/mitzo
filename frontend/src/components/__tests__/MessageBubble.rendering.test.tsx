// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { beforeEach } from 'vitest';
import { installDialogStub } from './dialog-stub';
beforeEach(installDialogStub);
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import {
  artifactMarkdownComponents,
  artifactUrlTransform,
  remarkPlugins,
  rehypePlugins,
} from '../../lib/markdown-config';
vi.mock('../../lib/share-file', () => ({
  shareFile: vi.fn().mockResolvedValue(true),
  downloadFile: vi.fn(),
}));
import { shareFile } from '../../lib/share-file';
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
  it('shares a stored Telos link without opening another app or losing its revision', async () => {
    const href = '/api/telos/artifacts/' + 'a'.repeat(32) + '?revision=2';
    render(
      <MemoryRouter>
        <TextBubble content={`[Telos artifact](${href})`} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Telos artifact' });
    expect(link.getAttribute('target')).toBeNull();
    fireEvent.click(link);
    expect(screen.getByRole('dialog', { name: 'File options' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Share file' }));
    expect(shareFile).toHaveBeenCalledWith(href);
    cleanup();
  });

  it('shares the exact revision from a bare Telos URL', () => {
    vi.mocked(shareFile).mockClear();
    const href = '/api/telos/artifacts/' + 'b'.repeat(32) + '?revision=2';
    render(
      <MemoryRouter>
        <TextBubble content={`Saved ${href}.`} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: href });
    expect(link.getAttribute('target')).toBeNull();
    fireEvent.click(link);
    expect(screen.getByRole('dialog', { name: 'File options' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Share file' }));
    expect(shareFile).toHaveBeenCalledExactlyOnceWith(href);
    cleanup();
  });

  it.each([
    '/workspace/report.pdf',
    '/workspace/report.docx',
    '/workspace/report.xml',
    '/workspace/packet.bin',
    'file:///workspace/report.xlsx',
    'sandbox:/mnt/data/report.pptx',
  ])('keeps generated document link %s inside Mitzo', (href) => {
    const html = renderBubble(`[report](${href})`);
    expect(html).toContain('file-path-link');
    expect(html).not.toContain('target="_blank"');
  });

  it.each([
    'file://remote-host/report.pdf',
    'sandbox:/mnt/data/%E0%A4%A.pdf',
    'javascript:alert(1)',
  ])('keeps filtered destination %s readable without opening the app URL', (href) => {
    const html = renderBubble(`[report](${href})`);
    expect(html).toContain('report');
    expect(html).not.toContain('href=""');
    expect(html).not.toContain('target="_blank"');
  });

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

  it('keeps fragment links in the current webview', () => {
    expect(renderBubble('[section](#section)')).not.toContain('target="_blank"');
  });

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

describe('historic absolute Markdown destinations', () => {
  it.each([
    '/workspace/report.md',
    '/workspace/My%20Report.md:12',
    'file:///workspace/report.md',
    'file://localhost/workspace/report.md',
  ])('routes stored chat destination %s through the viewer', (href) => {
    const message: FinishedMessage = {
      messageId: 'stored',
      role: 'assistant',
      blocks: [
        { blockId: 'text', blockType: 'text', content: `Recovered [report](${href}) for review.` },
      ],
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <MessageBubble message={message} />
      </MemoryRouter>,
    );
    expect(html).toContain('file-path-link');
    expect(html).toContain(
      `data-file-path="${href.includes('My') ? '/workspace/My Report.md' : '/workspace/report.md'}"`,
    );
  });

  it.each(['/workspace/report.md', 'file:///workspace/report.md'])(
    'routes nested Markdown destination %s with session scope',
    (href) => {
      const html = renderToStaticMarkup(
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          urlTransform={artifactUrlTransform}
          components={artifactMarkdownComponents(
            '/workspace/index.md',
            'old-session',
            '/chat/old-session',
            () => {},
          )}
        >{`[report](${href})`}</ReactMarkdown>,
      );
      expect(html).toContain('/files?path=%2Fworkspace%2Freport.md');
      expect(html).toContain('sessionId=old-session');
    },
  );

  it.each([
    'https://example.com/report.md',
    '//example.com/report.md',
    '/files?path=report.md',
    '/chat/report.md',
    '/sessions/report.md',
    '/%63hat/report.md',
    '#report',
    'javascript:alert(1)',
    'file://remote/workspace/report.md',
  ])('preserves browser destinations or neutralizes unsafe href %s', (href) => {
    const html = renderBubble(`See [report](${href}) here.`);
    expect(html).not.toContain('file-path-link');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="file:');
  });
});

it('opens an unchanged restored Markdown message with its originating session', () => {
  function Location() {
    const location = useLocation();
    return <output data-testid="restored-location">{location.pathname + location.search}</output>;
  }
  const message: FinishedMessage = {
    messageId: 'persisted-message',
    role: 'assistant',
    blocks: [
      {
        blockId: 'text',
        blockType: 'text',
        content: 'Read [report](/workspace/My%20Report.md:12) for details.',
      },
    ],
  };
  render(
    <MemoryRouter initialEntries={['/chat/old-session']}>
      <MessageBubble
        message={JSON.parse(JSON.stringify(message))}
        artifactSessionId="old-session"
      />
      <Location />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'report' }));
  const url = new URL(screen.getByTestId('restored-location').textContent!, 'https://mitzo.test');
  expect(url.pathname).toBe('/files');
  expect(url.searchParams.get('path')).toBe('/workspace/My Report.md');
  expect(url.searchParams.get('sessionId')).toBe('old-session');
  expect(url.searchParams.get('from')).toBe('/chat/old-session');
  cleanup();
});

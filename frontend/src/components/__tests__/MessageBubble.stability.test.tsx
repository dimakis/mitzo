// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextBubble } from '../MessageBubble';
import { apiFetch } from '../../lib/api-fetch';
import rehypeHighlight from 'rehype-highlight';

vi.mock('rehype-highlight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('rehype-highlight')>();
  return { ...actual, default: vi.fn(actual.default) };
});

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg><text>Diagram</text></svg>' })),
  },
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiFetch)
    .mockReset()
    .mockResolvedValue({
      ok: true,
      json: async () => ({ content: 'Expanded document content' }),
    } as Response);
});

function Harness({ content, sessionId }: { content: string; sessionId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <TextBubble content={content} artifactSessionId={sessionId} />
      <button onClick={() => navigate('?panel=files')}>Change panel</button>
      <output data-testid="location">{location.pathname + location.search}</output>
    </>
  );
}

describe('expanded message previews', () => {
  it('parses a restored response once across measurement, collapse and parent updates', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600);
    const content = 'Saved response\n\n```ts\nconst saved = true;\n```';
    const bubble = (text = content, timestamp = 1) => (
      <MemoryRouter>
        <TextBubble content={text} timestamp={timestamp} artifactSessionId="session-1" />
      </MemoryRouter>
    );
    const view = render(bubble());

    expect(screen.getByRole('button', { name: 'Show more' })).toBeDefined();
    expect(rehypeHighlight).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    view.rerender(bubble(content, 2));
    expect(rehypeHighlight).toHaveBeenCalledTimes(1);

    view.rerender(bubble(content + '\n\nNew text', 2));
    expect(screen.getByText('New text')).toBeDefined();
    expect(rehypeHighlight).toHaveBeenCalledTimes(2);
  });

  it('adds collapse controls when an asynchronously rendered diagram grows', async () => {
    let height = 100;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height);
    let notifyResize: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = () => callback([], this as unknown as ResizeObserver);
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    const view = render(
      <MemoryRouter>
        <TextBubble content={'```mermaid\ngraph TD; A-->B;\n```'} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(view.container.querySelector('.mermaid-block-svg')).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(notifyResize).toBeDefined();
    height = 600;
    act(() => notifyResize!());
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeDefined();
    height = 100;
    act(() => notifyResize!());
    expect(screen.queryByRole('button', { name: 'Show less' })).toBeNull();
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it.each(['md', 'html'])('loads fresh content when the inline %s file changes', async (ext) => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: 'FIRST DOCUMENT' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: 'SECOND DOCUMENT' }),
      } as Response);
    const link = (name: string) => `[preview](file-path://%2Ftmp%2F${name}.${ext})`;
    const bubble = (name: string) => (
      <MemoryRouter>
        <TextBubble content={link(name)} artifactSessionId="session-1" />
      </MemoryRouter>
    );
    const view = render(bubble('first'));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`first\\.${ext}`) }));
    const delivered = new WeakMap<HTMLIFrameElement, ReturnType<typeof vi.spyOn>>();
    const previewContent = () => {
      if (ext === 'md') return view.container.querySelector('.md-preview-card-body')?.textContent;
      const frame = view.container.querySelector('iframe');
      if (!frame) return undefined;
      if (!delivered.has(frame)) {
        delivered.set(frame, vi.spyOn(frame.contentWindow!, 'postMessage'));
        fireEvent.load(frame);
      }
      return (delivered.get(frame)!.mock.calls[0]?.[0] as { html?: string } | undefined)?.html;
    };
    await waitFor(() => expect(previewContent()).toContain('FIRST DOCUMENT'));
    view.rerender(bubble('second'));
    expect(previewContent()).toBeFalsy();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`second\\.${ext}`) }));
    await waitFor(() => expect(previewContent()).toContain('SECOND DOCUMENT'));
    expect(previewContent()).not.toContain('FIRST DOCUMENT');
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiFetch).mock.calls[1][0]).toContain('second');
  });

  it('survives content, parent and query-string updates while keeping current link routing', async () => {
    const content =
      '[notes](file-path://%2Ftmp%2Fnotes.md)\n\n[other](file-path://%2Ftmp%2Fother.txt)';
    const view = render(
      <MemoryRouter initialEntries={['/chat/session-1']}>
        <Harness content={content} sessionId="session-1" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /notes.md/ }));
    await screen.findByText('Expanded document content');
    view.rerender(
      <MemoryRouter initialEntries={['/chat/session-1']}>
        <Harness content={content + '\n\nMore tokens'} sessionId="session-1" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Expanded document content')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Change panel' }));
    expect(screen.getByText('Expanded document content')).toBeDefined();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('link', { name: 'other' }));
    const url = new URL(screen.getByTestId('location').textContent!, 'https://mitzo.test');
    expect(url.searchParams.get('from')).toBe('/chat/session-1?panel=files');
    expect(url.searchParams.get('sessionId')).toBe('session-1');
  });
});

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HtmlPreviewCard } from '../HtmlPreviewCard';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: '/chat/session-1', search: '' }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('HtmlPreviewCard', () => {
  it('loads and renders an HTML artifact inline without an extra click', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ content: '<!doctype html>', ext: '.html' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(<HtmlPreviewCard filePath="/tmp/prototype.html" sessionId="session-1" />);

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/files/read?path=%2Ftmp%2Fprototype.html&sessionId=session-1',
      ),
    );
    expect((await screen.findByTitle('prototype.html preview')).getAttribute('sandbox')).toBe(
      'allow-scripts',
    );
  });

  it('opens the artifact in the file viewer', () => {
    render(<HtmlPreviewCard filePath="/tmp/prototype.html" sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(navigate).toHaveBeenCalledWith(
      `/files?path=${encodeURIComponent('/tmp/prototype.html')}&from=${encodeURIComponent('/chat/session-1')}&sessionId=session-1`,
    );
  });
});

it('opens the resolved file after previewing a repository alias', async () => {
  const path = '/repo/.claude/worktrees/session-1/prototype.html';
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ path, content: '<h1>Worktree</h1>' })),
  );
  render(<HtmlPreviewCard filePath="/repo/prototype.html" sessionId="session-1" />);
  await screen.findByTitle('prototype.html preview');
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(new URL(navigate.mock.lastCall![0], 'https://mitzo.test').searchParams.get('path')).toBe(
    path,
  );
});

it('keeps the same iframe and interactive state when collapsed and reopened', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ content: '<button>Try</button>' })),
  );
  render(<HtmlPreviewCard filePath="/tmp/mockup.html" />);
  const frame = await screen.findByTitle('mockup.html preview');
  const toggle = screen.getByRole('button', { name: /mockup\.html/i });
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(frame.closest('[hidden]')).not.toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByTitle('mockup.html preview')).toBe(frame);
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('offers a retry after a load failure and rejects malformed content', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(new Response(JSON.stringify({ content: 7 })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ content: '<h1>Ready</h1>' })));
  render(<HtmlPreviewCard filePath="/tmp/mockup.html" />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByTitle('mockup.html preview')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
  expect(await screen.findByTitle('mockup.html preview')).toBeTruthy();
});

it('accepts an empty HTML document', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ content: '' })));
  render(<HtmlPreviewCard filePath="/tmp/empty.html" />);
  expect(await screen.findByTitle('empty.html preview')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('does not show stale content or a late result after the artifact identity changes', async () => {
  let completeFirst!: (response: Response) => void;
  vi.mocked(apiFetch)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeFirst = resolve;
        }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ path: '/resolved/second.html', content: '<h1>Second</h1>' })),
    );
  const { rerender } = render(<HtmlPreviewCard filePath="/tmp/first.html" sessionId="first" />);
  rerender(<HtmlPreviewCard filePath="/tmp/second.html" sessionId="second" />);
  const second = (await screen.findByTitle('second.html preview')) as HTMLIFrameElement;
  const post = vi.spyOn(second.contentWindow!, 'postMessage');
  fireEvent.load(second);
  await act(async () => {
    completeFirst(
      new Response(JSON.stringify({ path: '/resolved/first.html', content: '<h1>First</h1>' })),
    );
  });
  expect(post).toHaveBeenCalledWith(
    { type: 'mitzo:render-preview', html: expect.stringContaining('Second') },
    '*',
  );
  expect(screen.getByTitle('second.html preview')).toBe(second);
  expect(screen.queryByTitle('first.html preview')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(new URL(navigate.mock.lastCall![0], 'https://mitzo.test').searchParams.get('path')).toBe(
    '/resolved/second.html',
  );
});

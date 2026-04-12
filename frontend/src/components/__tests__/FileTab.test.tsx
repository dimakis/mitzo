// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { FileTab } from '../FileTab';

afterEach(() => cleanup());

// Mock react-markdown — renders children as plain text
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock('remark-gfm', () => ({ default: () => {} }));

function mockFetchSuccess(content: string) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ content }),
  });
}

function mockFetchError() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    json: () => Promise.reject(new Error('fail')),
  });
}

describe('FileTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows loading state initially', () => {
    // Fetch that never resolves
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<FileTab filePath="/src/index.ts" />);
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('shows error state on fetch failure', async () => {
    mockFetchError();
    render(<FileTab filePath="/src/index.ts" />);
    await waitFor(() => expect(screen.getByText('Failed to load file')).toBeTruthy());
  });

  it('renders markdown for .md files', async () => {
    mockFetchSuccess('# Hello');
    render(<FileTab filePath="/docs/readme.md" />);
    await waitFor(() => expect(screen.getByTestId('markdown')).toBeTruthy());
    expect(screen.getByText('# Hello')).toBeTruthy();
  });

  it('renders markdown for .mdx files', async () => {
    mockFetchSuccess('## MDX content');
    render(<FileTab filePath="/docs/page.mdx" />);
    await waitFor(() => expect(screen.getByTestId('markdown')).toBeTruthy());
  });

  it('renders plain pre for non-markdown files', async () => {
    mockFetchSuccess('const x = 1;');
    const { container } = render(<FileTab filePath="/src/index.ts" />);
    await waitFor(() => expect(screen.getByText('const x = 1;')).toBeTruthy());
    expect(container.querySelector('pre.file-tab-code')).toBeTruthy();
    expect(container.querySelector('[data-testid="markdown"]')).toBeNull();
  });

  it('re-fetches when filePath changes', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ content: 'file1' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ content: 'file2' }),
    });
    global.fetch = fetchMock;

    const { rerender } = render(<FileTab filePath="/a.ts" />);
    await waitFor(() => expect(screen.getByText('file1')).toBeTruthy());

    rerender(<FileTab filePath="/b.ts" />);
    await waitFor(() => expect(screen.getByText('file2')).toBeTruthy());

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

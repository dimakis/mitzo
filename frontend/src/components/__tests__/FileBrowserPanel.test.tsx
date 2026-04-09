// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { FileBrowserPanel } from '../FileBrowserPanel';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetch(responses: Record<string, unknown>) {
  (fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    for (const [pattern, data] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
      }
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe('FileBrowserPanel', () => {
  it('fetches and renders roots from config', async () => {
    mockFetch({
      '/api/config': {
        fileViewerRoots: [
          { label: 'Project', path: '/home/user/project' },
          { label: 'Docs', path: '/home/user/docs' },
        ],
      },
      '/api/files/list': { entries: [], currentDir: '/home/user/project' },
    });
    render(<FileBrowserPanel />);
    await waitFor(() => {
      expect(screen.getByText('Project')).toBeTruthy();
      expect(screen.getByText('Docs')).toBeTruthy();
    });
  });

  it('renders directory entries', async () => {
    mockFetch({
      '/api/config': {
        fileViewerRoots: [{ label: 'Project', path: '/home/user/project' }],
      },
      '/api/files/list': {
        entries: [
          { name: 'src', isDir: true },
          { name: 'README.md', isDir: false },
        ],
        currentDir: '/home/user/project',
      },
    });
    render(<FileBrowserPanel />);
    await waitFor(() => {
      expect(screen.getByText('src/')).toBeTruthy();
      expect(screen.getByText('README.md')).toBeTruthy();
    });
  });

  it('navigates into directory on click', async () => {
    mockFetch({
      '/api/config': {
        fileViewerRoots: [{ label: 'Project', path: '/p' }],
      },
      '/api/files/list': {
        entries: [{ name: 'src', isDir: true }],
        currentDir: '/p',
      },
    });
    render(<FileBrowserPanel />);
    await waitFor(() => screen.getByText('src/'));

    // Update mock for subdirectory
    mockFetch({
      '/api/config': {
        fileViewerRoots: [{ label: 'Project', path: '/p' }],
      },
      '/api/files/list': {
        entries: [{ name: 'index.ts', isDir: false }],
        currentDir: '/p/src',
      },
    });

    fireEvent.click(screen.getByText('src/'));
    await waitFor(() => {
      expect(screen.getByText('index.ts')).toBeTruthy();
    });
  });

  it('shows back button when in subdirectory', async () => {
    mockFetch({
      '/api/config': {
        fileViewerRoots: [{ label: 'Project', path: '/p' }],
      },
      '/api/files/list': {
        entries: [{ name: 'src', isDir: true }],
        currentDir: '/p',
      },
    });
    render(<FileBrowserPanel />);
    await waitFor(() => screen.getByText('src/'));

    // Navigate into src
    mockFetch({
      '/api/config': {
        fileViewerRoots: [{ label: 'Project', path: '/p' }],
      },
      '/api/files/list': {
        entries: [{ name: 'index.ts', isDir: false }],
        currentDir: '/p/src',
      },
    });
    fireEvent.click(screen.getByText('src/'));
    await waitFor(() => {
      expect(screen.getByText('..')).toBeTruthy();
    });
  });

  it('shows file preview when file clicked', async () => {
    mockFetch({
      '/api/config': {
        fileViewerRoots: [{ label: 'Project', path: '/p' }],
      },
      '/api/files/list': {
        entries: [{ name: 'hello.txt', isDir: false }],
        currentDir: '/p',
      },
      '/api/files/read': { content: 'Hello world!', ext: '.txt' },
    });
    render(<FileBrowserPanel />);
    await waitFor(() => screen.getByText('hello.txt'));
    fireEvent.click(screen.getByText('hello.txt'));
    await waitFor(() => {
      expect(screen.getByText('Hello world!')).toBeTruthy();
    });
  });

  it('handles empty directory', async () => {
    mockFetch({
      '/api/config': {
        fileViewerRoots: [{ label: 'Project', path: '/p' }],
      },
      '/api/files/list': { entries: [], currentDir: '/p' },
    });
    render(<FileBrowserPanel />);
    await waitFor(() => {
      expect(screen.getByText('Empty directory')).toBeTruthy();
    });
  });
});

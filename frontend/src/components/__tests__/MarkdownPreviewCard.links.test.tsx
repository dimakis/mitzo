// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownPreviewCard } from '../MarkdownPreviewCard';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/share-file', () => ({ shareFile: vi.fn().mockResolvedValue(true) }));
import { shareFile } from '../../lib/share-file';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(cleanup);

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

describe('MarkdownPreviewCard links', () => {
  it('shares a collapsed preview in its originating session', async () => {
    render(
      <MemoryRouter>
        <MarkdownPreviewCard filePath="outputs/report.md" sessionId="old-session" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Share file' }));
    await waitFor(() => expect(shareFile).toHaveBeenCalledWith('outputs/report.md', 'old-session'));
    expect(screen.queryByText('Loading...')).toBeNull();
  });

  it.each([
    'This sandbox is stopped. Resume the conversation to access its files.',
    'This sandbox workspace is no longer available.',
  ])('shows the server workspace guidance: %s', async (message) => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({ error: message }),
    } as never);
    render(
      <MemoryRouter>
        <MarkdownPreviewCard filePath="report.md" sessionId="sandbox-session" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /report.md/ }));
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it.each([
    ['[details](details.html)', 'outputs/details.html'],
    [
      '[details](file-path://%2Fsession-workspace%2Fdetails.html)',
      '/session-workspace/details.html',
    ],
  ])('opens %s in the originating session', async (content, expectedPath) => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ content }),
    } as never);
    render(
      <MemoryRouter initialEntries={['/chat/session-1']}>
        <MarkdownPreviewCard filePath="outputs/report.md" sessionId="session-1" />
        <Location />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /report.md/ }));
    const link = await screen.findByRole('link', { name: 'details' });
    fireEvent.click(link);

    await waitFor(() => {
      const url = new URL(screen.getByTestId('location').textContent!, 'https://mitzo.test');
      expect(url.pathname).toBe('/files');
      expect(url.searchParams.get('path')).toBe(expectedPath);
      expect(url.searchParams.get('sessionId')).toBe('session-1');
    });
  });
});

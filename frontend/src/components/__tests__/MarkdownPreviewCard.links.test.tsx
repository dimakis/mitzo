// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownPreviewCard } from '../MarkdownPreviewCard';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(cleanup);

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

describe('MarkdownPreviewCard links', () => {
  it('opens a sibling artifact in the originating session', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ content: '[details](details.html)' }),
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
      expect(url.searchParams.get('path')).toBe('outputs/details.html');
      expect(url.searchParams.get('sessionId')).toBe('session-1');
    });
  });
});

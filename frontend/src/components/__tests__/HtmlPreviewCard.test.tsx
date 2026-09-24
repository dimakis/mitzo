// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it('loads and renders an HTML artifact when expanded', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ content: '<!doctype html>', ext: '.html' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(<HtmlPreviewCard filePath="/tmp/prototype.html" sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: /prototype\.html/i }));

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

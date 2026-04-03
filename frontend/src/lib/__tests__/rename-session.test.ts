import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renameSession } from '../rename-session';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('renameSession', () => {
  it('calls PUT /api/sessions/:id/rename with title', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await renameSession('sess-1', 'New Title');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/sessions/sess-1/rename',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ title: 'New Title' }),
      }),
    );
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Not found' }),
    });
    await expect(renameSession('sess-1', 'Title')).rejects.toThrow('Not found');
  });
});

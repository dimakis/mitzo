// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../api-fetch';
import { readApiJson } from '../api-json-read';
vi.mock('../api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('bounded metadata JSON reads', () => {
  it('bounds the body read as well as response headers', async () => {
    vi.useFakeTimers();
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    } as Response);
    const read = readApiJson('/api/example').catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await read).toBe('Read request timed out');
    expect(vi.mocked(apiFetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it('settles immediately when the owner aborts even if fetch never settles', async () => {
    vi.mocked(apiFetch).mockReturnValue(new Promise(() => {}));
    const owner = new AbortController();
    const read = readApiJson('/api/example', owner.signal).catch((error: Error) => error.name);
    owner.abort();
    expect(await read).toBe('AbortError');
    expect(vi.mocked(apiFetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it('performs only GET reads and reports failed status', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(readApiJson('/api/example')).rejects.toThrow('Read request failed (503)');
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/example',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(vi.mocked(apiFetch).mock.calls[0][1]?.method).toBeUndefined();
  });
});

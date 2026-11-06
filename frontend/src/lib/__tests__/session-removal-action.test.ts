import { afterEach, expect, it, vi } from 'vitest';
import { sessionRemovalAction } from '../session-removal-action';
import { apiFetch } from '../api-fetch';
vi.mock('../api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
it('bounds a stalled response body and never retries a removal mutation', async () => {
  vi.useFakeTimers();
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: () => new Promise(() => {}),
  } as Response);
  const request = sessionRemovalAction('/prepare', {});
  const result = expect(request).rejects.toThrow(/unconfirmed/);
  await vi.advanceTimersByTimeAsync(125_000);
  await result;
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

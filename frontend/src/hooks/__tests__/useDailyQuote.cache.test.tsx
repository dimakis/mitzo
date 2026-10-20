// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDailyQuote } from '../useDailyQuote';
import { cachedDailyQuote, saveDailyQuote } from '../../lib/launch-quote';
import catalog from '../../../../content/quotes/catalog.json';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api-fetch', () => ({ apiFetch: fetchMock }));
const daily = { date: '2026-10-17', quote: catalog[0] };
beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('renders the saved daily quote immediately while revalidating', () => {
  saveDailyQuote(daily);
  fetchMock.mockReturnValue(new Promise(() => {}));
  const { result } = renderHook(() => useDailyQuote(daily.date));
  expect(result.current.quote).toEqual(daily);
  expect(result.current.loading).toBe(false);
});
it('saves the fetched quote for the next cold launch', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(daily)));
  renderHook(() => useDailyQuote(daily.date));
  await waitFor(() => expect(cachedDailyQuote(daily.date)).toEqual(daily));
});
it('retains a cached quote when revalidation fails', async () => {
  saveDailyQuote(daily);
  fetchMock.mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useDailyQuote(daily.date));
  await act(async () => {});
  expect(result.current.quote).toEqual(daily);
  expect(result.current.error).toBeNull();
});

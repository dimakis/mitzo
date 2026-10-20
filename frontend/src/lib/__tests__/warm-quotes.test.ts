// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { warmQuotes } from '../warm-quotes';
import { cachedDailyQuote, saveDailyQuote } from '../launch-quote';
import catalog from '../../../../content/quotes/catalog.json';
beforeEach(() => localStorage.clear());
it('prepares the next week once, in date order, skipping cached dates', async () => {
  saveDailyQuote({ date: '2026-10-18', quote: catalog[0] });
  const read = vi.fn(async (date: string) => ({ date, quote: catalog[0] }));
  await warmQuotes('2026-10-17', read, new AbortController().signal);
  expect(read.mock.calls.map((call) => call[0])).toEqual([
    '2026-10-19',
    '2026-10-20',
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
    '2026-10-24',
  ]);
  expect(cachedDailyQuote('2026-10-24')?.quote).toEqual(catalog[0]);
});
it('does not save a late result after navigation or logout cancels warming', async () => {
  const controller = new AbortController();
  await warmQuotes(
    '2026-10-17',
    async (date) => {
      controller.abort();
      return { date, quote: catalog[0] };
    },
    controller.signal,
  );
  expect(cachedDailyQuote('2026-10-18')).toBeNull();
});
it('stops at an unavailable server instead of retrying background requests', async () => {
  const read = vi.fn().mockRejectedValue(new Error('offline'));
  await warmQuotes('2026-10-17', read, new AbortController().signal);
  expect(read).toHaveBeenCalledOnce();
});

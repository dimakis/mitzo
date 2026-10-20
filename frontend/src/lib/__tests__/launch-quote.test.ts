// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { readLaunchQuote, saveDailyQuote, setLaunchQuoteEnabled } from '../launch-quote';
import catalog from '../../../../content/quotes/catalog.json';
const date = '2026-10-17';
beforeEach(() => {
  localStorage.clear();
  vi.unstubAllEnvs();
});
it('shows an attributed bundled quote without a server or stored data', () => {
  expect(readLaunchQuote(date)).toMatchObject({
    source: 'bundled',
    quote: { text: expect.any(String), author: expect.any(String) },
  });
});
it('reuses the exact server-selected quote only for its date and server', () => {
  const daily = { date, quote: catalog[3] };
  saveDailyQuote(daily);
  expect(readLaunchQuote(date)).toMatchObject({ source: 'daily', ...daily });
  expect(readLaunchQuote('2026-10-18')?.source).toBe('bundled');
  vi.stubEnv('VITE_API_BASE_URL', 'https://another.invalid');
  expect(readLaunchQuote(date)?.source).toBe('bundled');
});
it('honors a locally remembered hidden-quote preference', () => {
  setLaunchQuoteEnabled(false);
  expect(readLaunchQuote(date)).toBeNull();
  setLaunchQuoteEnabled(true);
  expect(readLaunchQuote(date)).not.toBeNull();
});
it('survives unavailable local storage', () => {
  const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(readLaunchQuote(date)?.source).toBe('bundled');
  spy.mockRestore();
});
it('does not accept malformed server data as a quote', () => {
  saveDailyQuote({ date, quote: { text: '<script>', author: null } } as never);
  expect(readLaunchQuote(date)?.source).toBe('bundled');
});

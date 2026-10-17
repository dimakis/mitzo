import type { DailyQuote, PhilosophyQuote } from '@mitzo/protocol';
import catalog from '../../../content/quotes/catalog.json';
import { getApiBaseUrl } from './api-base-url';

// Only published, non-personal quotes belong here. Never cache workspace content.
const key = () => `mitzo:launch-quotes:v1:${getApiBaseUrl() || 'same-origin'}`;
interface SavedQuotes {
  enabled?: boolean;
  daily: DailyQuote[];
}
function read(): SavedQuotes {
  try {
    const value = JSON.parse(localStorage.getItem(key()) || '{}');
    return {
      enabled: value.enabled !== false,
      daily: Array.isArray(value.daily) ? value.daily.filter(validDailyQuote).slice(-8) : [],
    };
  } catch {
    return { daily: [] };
  }
}
function write(value: SavedQuotes) {
  try {
    localStorage.setItem(key(), JSON.stringify(value));
  } catch {
    /* Optional offline decoration. */
  }
}
export function validDailyQuote(value: unknown): value is DailyQuote {
  if (!value || typeof value !== 'object') return false;
  const daily = value as DailyQuote;
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(daily.date) &&
    Boolean(daily.quote) &&
    [
      'id',
      'text',
      'author',
      'work',
      'translation',
      'explanation',
      'example',
      'biography',
      'sourceUrl',
      'explainerUrl',
      'authorUrl',
    ].every(
      (field) =>
        typeof daily.quote[field as keyof PhilosophyQuote] === 'string' &&
        daily.quote[field as keyof PhilosophyQuote].length < 10_000,
    )
  );
}
export function saveDailyQuote(daily: DailyQuote) {
  if (!validDailyQuote(daily)) return;
  const saved = read();
  saved.daily = [...saved.daily.filter((item) => item.date !== daily.date), daily]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-8);
  write(saved);
}
export function setLaunchQuoteEnabled(enabled: boolean) {
  write({ ...read(), enabled });
}
export function cachedDailyQuote(date: string): DailyQuote | null {
  return read().daily.find((item) => item.date === date) ?? null;
}
export function localQuoteDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function readLaunchQuote(date = localQuoteDate()) {
  const saved = read();
  if (saved.enabled === false) return null;
  const daily = saved.daily.find((item) => item.date === date);
  if (daily) return { ...daily, source: 'daily' as const };
  // A bundled literary quote is never represented as the server's daily selection.
  const index = [...date].reduce((sum, char) => sum + char.charCodeAt(0), 0) % catalog.length;
  return { date, quote: catalog[index], source: 'bundled' as const };
}

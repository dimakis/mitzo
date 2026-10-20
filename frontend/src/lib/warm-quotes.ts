import type { DailyQuote } from '@mitzo/protocol';
import { cachedDailyQuote, saveDailyQuote, validDailyQuote } from './launch-quote';
/** Existing server selection pins future dates too; never invent a different daily quote. */
export async function warmQuotes(
  date: string,
  read: (date: string) => Promise<DailyQuote>,
  signal: AbortSignal,
) {
  const day = new Date(`${date}T12:00:00Z`);
  for (let offset = 1; offset <= 7 && !signal.aborted; offset++) {
    day.setUTCDate(day.getUTCDate() + 1);
    const next = day.toISOString().slice(0, 10);
    if (cachedDailyQuote(next)) continue;
    try {
      const result = await read(next);
      if (signal.aborted || result.date !== next || !validDailyQuote(result)) return;
      saveDailyQuote(result);
    } catch {
      return;
    }
  }
}

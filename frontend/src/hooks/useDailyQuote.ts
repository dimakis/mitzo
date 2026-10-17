import { useEffect, useState } from 'react';
import type { DailyQuote } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { warmQuotes } from '../lib/warm-quotes';
import { cachedDailyQuote, localQuoteDate, saveDailyQuote } from '../lib/launch-quote';

export function useDailyQuote(date: string) {
  const [result, setResult] = useState<{
    date: string;
    quote: DailyQuote | null;
    error: string | null;
  } | null>(() => {
    const quote = cachedDailyQuote(date);
    return quote ? { date, quote, error: null } : null;
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let warmTimer: ReturnType<typeof setTimeout> | undefined;
    let warmDeadline: ReturnType<typeof setTimeout> | undefined;
    void apiFetch(`/api/home/quote?${new URLSearchParams({ date })}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Quote unavailable');
        const daily: DailyQuote = await response.json();
        if (
          !daily ||
          daily.date !== date ||
          typeof daily.quote?.text !== 'string' ||
          typeof daily.quote.author !== 'string'
        )
          throw new Error('Invalid quote');
        if (!controller.signal.aborted) {
          saveDailyQuote(daily);
          setResult({ date, quote: daily, error: null });
          // Defer optional future-day reads until after the home screen has rendered.
          if (date === localQuoteDate())
            warmTimer = setTimeout(() => {
              warmDeadline = setTimeout(() => controller.abort(), 5_000);
              void warmQuotes(
                date,
                async (next) => {
                  const response = await apiFetch(
                    `/api/home/quote?${new URLSearchParams({ date: next })}`,
                    { signal: controller.signal },
                  );
                  if (!response.ok) throw new Error('Quote unavailable');
                  return response.json();
                },
                controller.signal,
              ).finally(() => clearTimeout(warmDeadline));
            }, 2_000);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResult(() => {
            const quote = cachedDailyQuote(date);
            return { date, quote, error: quote ? null : 'Couldn’t load the quote. Try again.' };
          });
      });
    return () => {
      clearTimeout(warmTimer);
      clearTimeout(warmDeadline);
      controller.abort();
    };
  }, [date, attempt]);
  const current = result?.date === date ? result : null;
  return {
    quote: current?.quote ?? null,
    loading: !current,
    error: current?.error ?? null,
    retry: () => {
      setResult(null);
      setAttempt((value) => value + 1);
    },
  };
}

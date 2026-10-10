import { useEffect, useState } from 'react';
import type { DailyQuote } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';

export function useDailyQuote(date: string) {
  const [result, setResult] = useState<{
    date: string;
    quote: DailyQuote | null;
    error: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
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
        if (!controller.signal.aborted) setResult({ date, quote: daily, error: null });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResult({ date, quote: null, error: 'Couldn’t load the quote. Try again.' });
      });
    return () => controller.abort();
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

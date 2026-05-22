import { useState, useCallback, useEffect, useRef } from 'react';
import { copyToClipboard } from '../lib/clipboard';

export function useCopyFeedback(durationMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyToClipboard(text);
      if (ok) {
        setCopied(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), durationMs);
      }
    },
    [durationMs],
  );

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { copied, copy };
}

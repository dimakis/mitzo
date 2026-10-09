import { useEffect, useState } from 'react';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { BriefingChatBinding } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { useHomePreferences } from './useHomePreferences';

/** Dated source identity survives normal rich-chat navigation and restore. */
export function useBriefingChat(sessionId: string | null) {
  const launch = useMitzoStore((store) => store.pendingSession);
  const { preferences } = useHomePreferences();
  const [loaded, setLoaded] = useState<{
    sessionId: string;
    binding: BriefingChatBinding | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const changed = () => setAttempt((value) => value + 1);
    window.addEventListener('mitzo-briefing-chat', changed);
    return () => window.removeEventListener('mitzo-briefing-chat', changed);
  }, []);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    void (async () => {
      let binding: BriefingChatBinding | null = null;
      try {
        const response = await apiFetch(
          `/api/home/briefing-chats?sessionId=${encodeURIComponent(sessionId)}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error('Binding unavailable');
        const data: unknown = await response.json();
        if (Array.isArray(data))
          binding =
            data.find(
              (entry) =>
                entry?.sessionId === sessionId &&
                typeof entry.date === 'string' &&
                typeof entry.revision === 'string' &&
                typeof entry.accountId === 'string' &&
                typeof entry.model === 'string',
            ) ?? null;
      } catch {
        /* Ordinary conversations have no saved briefing identity. */
      }
      if (!controller.signal.aborted) setLoaded({ sessionId, binding });
    })();
    return () => controller.abort();
  }, [sessionId, attempt]);
  const binding = loaded?.sessionId === sessionId ? loaded.binding : null;
  const source = binding ?? (!sessionId ? launch?.briefing : null);
  return {
    binding,
    source,
    name: preferences?.names.briefing ?? 'Minion',
    isBriefing: !!source,
    loading: !!sessionId && loaded?.sessionId !== sessionId,
  };
}

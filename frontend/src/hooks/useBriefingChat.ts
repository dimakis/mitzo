import {
  confirmBriefingRegistration,
  verifyBriefingRegistration,
  useBriefingRegistration,
} from '../lib/briefing-registration';
import { useCallback, useEffect, useState } from 'react';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { BriefingChatBinding } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { useHomePreferences } from './useHomePreferences';

function isBinding(value: unknown): value is BriefingChatBinding {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (
    !['sessionId', 'date', 'revision', 'accountId', 'model', 'createdAt'].every(
      (key) => typeof entry[key] === 'string' && !!entry[key],
    )
  )
    return false;
  const date = new Date(`${entry.date}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(entry.date as string) &&
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === entry.date &&
    /^[a-f0-9]{64}$/.test(entry.revision as string)
  );
}

/** Dated source identity survives normal rich-chat navigation and restore. */
export function useBriefingChat(sessionId: string | null) {
  const registration = useBriefingRegistration(sessionId);
  const launch = useMitzoStore((store) => store.pendingSession);
  const { preferences } = useHomePreferences();
  const [loaded, setLoaded] = useState<{
    sessionId: string;
    binding: BriefingChatBinding | null;
    attempt: number;
    error?: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    const changed = retry;
    window.addEventListener('mitzo-briefing-chat', changed);
    return () => window.removeEventListener('mitzo-briefing-chat', changed);
  }, [retry]);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await apiFetch(
          `/api/home/briefing-chats?sessionId=${encodeURIComponent(sessionId)}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error('Binding unavailable');
        const data: unknown = await response.json();
        if (!Array.isArray(data)) throw new Error('Invalid binding response');
        const matches = data.filter((entry) => entry?.sessionId === sessionId);
        if (matches.length > 1 || (matches.length && !isBinding(matches[0])))
          throw new Error('Invalid saved binding');
        const binding: BriefingChatBinding | null = matches[0] ?? null;
        if (!controller.signal.aborted) {
          if (binding) verifyBriefingRegistration(binding);
          setLoaded({ sessionId, binding, attempt });
        }
      } catch {
        if (!controller.signal.aborted)
          setLoaded((previous) => ({
            sessionId,
            attempt,
            binding: previous?.sessionId === sessionId ? previous.binding : null,
            error:
              'Could not check this conversation’s briefing link. Retry to change account or model.',
          }));
      }
    })();
    return () => controller.abort();
  }, [sessionId, attempt]);
  useEffect(() => {
    if (loaded?.sessionId === sessionId && loaded.binding && !loaded.error)
      confirmBriefingRegistration(loaded.binding);
  }, [loaded, sessionId]);
  const binding =
    (loaded?.sessionId === sessionId ? loaded.binding : null) ??
    registration.record?.binding ??
    null;
  const error =
    (loaded?.sessionId === sessionId ? loaded.error : undefined) ||
    registration.storageError ||
    undefined;
  const loading = !!sessionId && (loaded?.sessionId !== sessionId || loaded.attempt !== attempt);
  const source = binding ?? (!sessionId ? launch?.briefing : null);
  return {
    binding,
    source,
    name: preferences?.names.briefing ?? 'Minion',
    isBriefing: !!source,
    loading,
    error,
    retry,
    selectionLocked: !!source || loading || !!error,
  };
}

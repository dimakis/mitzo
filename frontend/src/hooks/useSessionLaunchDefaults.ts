import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionLaunchConfig } from '@mitzo/protocol';
import {
  loadSessionLaunchDefaults,
  saveSessionLaunchDefaults,
  type SessionLaunchDefaults,
} from '../lib/session-launch-defaults';

/** One owner shares its read with consumers; no browser cache can grant launch authority. */
export function useSessionLaunchDefaults(enabled = true, scopeKey = 'session-defaults') {
  const currentScope = useRef({ scopeKey });
  if (currentScope.current.scopeKey !== scopeKey) currentScope.current = { scopeKey };
  const [stored, setStored] = useState<{ scopeKey: string; value: SessionLaunchDefaults } | null>(
    null,
  );
  const value = stored?.scopeKey === scopeKey ? stored.value : null;
  const [readScope, setReadScope] = useState(scopeKey);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(enabled);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let active = true;
    setReadScope(scopeKey);
    setSaving(false);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      active = false;
      controller.abort();
      setError('Session defaults are unavailable. Retry.');
      setLoading(false);
    }, 15_000);
    setLoading(true);
    setError('');
    void loadSessionLaunchDefaults(controller.signal)
      .then((next) => {
        if (active) setStored({ scopeKey, value: next });
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error ? reason.message : 'Session defaults are unavailable. Retry.',
          );
      })
      .finally(() => {
        clearTimeout(timeout);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [enabled, attempt, scopeKey]);
  const save = useCallback(
    async (configuration: SessionLaunchConfig | null) => {
      if (!value || saving || currentScope.current.scopeKey !== scopeKey) return false;
      const savingScope = currentScope.current;
      setSaving(true);
      setError('');
      try {
        const next = await saveSessionLaunchDefaults(configuration, value.revision);
        if (currentScope.current !== savingScope) return false;
        setStored({ scopeKey, value: next });
        return true;
      } catch (reason: unknown) {
        if (currentScope.current !== savingScope) return false;
        setError(
          reason instanceof Error ? reason.message : 'Could not save session defaults. Retry.',
        );
        return false;
      } finally {
        if (currentScope.current === savingScope) setSaving(false);
      }
    },
    [value, saving, scopeKey],
  );
  return {
    ...value,
    loading: enabled && (loading || readScope !== scopeKey),
    saving,
    error: readScope === scopeKey ? error : '',
    save,
    refresh: () => setAttempt((n) => n + 1),
  };
}

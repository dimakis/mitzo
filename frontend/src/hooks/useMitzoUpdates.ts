import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';
import type { QuickAction } from './useSessionList';
interface Version {
  updateAvailable: boolean;
  commit?: string;
  hash?: string;
}
export function useMitzoUpdates() {
  const [version, setVersion] = useState<Version | null>(null);
  const [action, setAction] = useState<QuickAction | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async (signal?: AbortSignal) => {
    const responses = await Promise.allSettled([
      apiFetch('/api/version', { signal }).then(async (response) => {
        if (!response.ok) throw Error('Version unavailable');
        const data = await response.json();
        if (typeof data.updateAvailable !== 'boolean') throw Error('Invalid version');
        return data as Version;
      }),
      apiFetch('/api/config', { signal }).then(async (response) => {
        if (!response.ok) throw Error('Configuration unavailable');
        const config = await response.json();
        return Array.isArray(config.quickActions)
          ? (config.quickActions.find((a: QuickAction) => a.label === 'Deploy Mitzo') ?? null)
          : null;
      }),
    ]);
    if (signal?.aborted) return;
    if (responses[0].status === 'fulfilled') setVersion(responses[0].value);
    if (responses[1].status === 'fulfilled') setAction(responses[1].value);
    if (responses.some((result) => result.status === 'rejected'))
      setError('Couldn’t load update information. Check your connection and try again.');
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [load]);
  const check = useCallback(async () => {
    setChecking(true);
    setError('');
    try {
      const response = await apiFetch('/api/version/check', { method: 'POST' });
      if (!response.ok) throw Error('Update check failed');
      const result = await response.json();
      if (typeof result.updateAvailable !== 'boolean') throw Error('Invalid update result');
      await load();
      setVersion((current) => ({ ...current, updateAvailable: result.updateAvailable }));
    } catch {
      setError('Couldn’t check for updates. Check your connection and try again.');
    } finally {
      setChecking(false);
    }
  }, [load]);
  return { version, action, loading, checking, error, check };
}

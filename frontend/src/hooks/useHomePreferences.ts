import { useCallback, useEffect, useRef, useState } from 'react';
import type { HomePreferences } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';

const LOCAL_CHANGE = 'mitzo-home-preferences-changed';
export type HomePreferencePatch = Partial<Pick<HomePreferences, 'names' | 'pins'>>;

/** Workspace preferences are server-owned. Revision checks protect edits on other devices. */
export function useHomePreferences() {
  const [preferences, setPreferences] = useState<HomePreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const current = useRef(preferences);
  current.current = preferences;
  const busy = useRef(false);
  const mounted = useRef(false);

  const reload = useCallback(async () => {
    const id = ++request.current;
    try {
      const response = await apiFetch('/api/home/preferences');
      if (!response.ok) throw new Error('Preferences unavailable');
      const result: HomePreferences = await response.json();
      if (mounted.current && id === request.current) setPreferences(result);
    } catch {
      if (mounted.current && id === request.current)
        setError('Couldn’t load your home preferences. Try again.');
    } finally {
      if (mounted.current && id === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const changed = () => void reload();
    const visible = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    window.addEventListener(LOCAL_CHANGE, changed);
    document.addEventListener('visibilitychange', visible);
    const unsubscribe = eventBus.on('home_preferences', changed);
    return () => {
      mounted.current = false;
      window.removeEventListener(LOCAL_CHANGE, changed);
      document.removeEventListener('visibilitychange', visible);
      unsubscribe();
    };
  }, [reload]);

  const update = useCallback(
    async (patch: HomePreferencePatch): Promise<boolean> => {
      if (!current.current || busy.current) return false;
      busy.current = true;
      setSaving(true);
      setError(null);
      // Fence reads begun before this write.
      request.current++;
      try {
        const response = await apiFetch('/api/home/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revision: current.current.revision, ...patch }),
        });
        if (response.status === 409) {
          await reload();
          if (mounted.current)
            setError('Your preferences changed on another device. Review them and try again.');
          return false;
        }
        if (!response.ok) throw new Error('Save failed');
        const result: HomePreferences = await response.json();
        if (mounted.current) setPreferences(result);
        current.current = result;
        window.dispatchEvent(new Event(LOCAL_CHANGE));
        return true;
      } catch {
        if (mounted.current) setError('Couldn’t save your preferences. Try again.');
        return false;
      } finally {
        busy.current = false;
        if (mounted.current) setSaving(false);
      }
    },
    [reload],
  );
  return { preferences, loading, saving, error, update, reload };
}

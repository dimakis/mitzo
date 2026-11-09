import { useRef, useState } from 'react';

export const layoutStorageNotice =
  'Layout changes apply for this tab; browser storage is unavailable.';

/** Optional layout preferences must never prevent interaction or fail silently. */
export function useLayoutPreference<T>(
  key: string,
  fallback: T,
  decode: (raw: string) => T,
  encode: (value: T) => string = JSON.stringify,
) {
  const [state, setState] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return {
        value: saved === null ? fallback : decode(saved),
        unavailable: false,
        cause: undefined as unknown,
      };
    } catch (cause) {
      report('read', cause);
      return { value: fallback, unavailable: true, cause };
    }
  });
  const warned = useRef(state.unavailable);
  function report(stage: string, cause: unknown) {
    console.warn('Layout preference unavailable', {
      code: 'layout_preference_unavailable',
      stage,
      key,
      cause: cause instanceof Error ? cause.name : 'UnknownError',
    });
  }
  function save(value: T) {
    let unavailable = false;
    let failure: unknown;
    try {
      localStorage.setItem(key, encode(value));
    } catch (cause) {
      failure = cause;
      unavailable = true;
      if (!warned.current) report('write', cause);
      warned.current = true;
    }
    // Retain the original failure internally; diagnostics expose only its name.
    setState({ value, unavailable, cause: failure });
  }
  return [state.value, save, state.unavailable] as const;
}

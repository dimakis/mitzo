import { useState, useEffect } from 'react';

export function useMediaQuery(query: string, fallback = false): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? fallback);

  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    setMatches(mql.matches);

    const handler = (e: MediaQueryListEvent | { matches: boolean }) => {
      setMatches(e.matches);
    };

    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 768px)', window.innerWidth >= 768);
}

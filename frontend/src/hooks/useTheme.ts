import { useCallback, useEffect, useState } from 'react';

type Theme = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'mitzo-theme';

function resolveTheme(preference: Theme): 'dark' | 'light' {
  if (preference !== 'system') return preference;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(resolved: 'dark' | 'light') {
  document.documentElement.setAttribute('data-theme', resolved);
  const meta = document.getElementById('theme-color-meta') as HTMLMetaElement | null;
  if (meta) meta.content = resolved === 'light' ? '#f5f5f7' : '#111113';
}

export function initTheme() {
  const stored = (localStorage.getItem(STORAGE_KEY) as Theme) || 'system';
  applyTheme(resolveTheme(stored));
}

export function useTheme() {
  const [preference, setPreference] = useState<Theme>(
    () => (localStorage.getItem(STORAGE_KEY) as Theme) || 'system',
  );

  const resolved = resolveTheme(preference);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  useEffect(() => {
    if (preference !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => applyTheme(resolveTheme('system'));
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [preference]);

  const setTheme = useCallback((theme: Theme) => {
    localStorage.setItem(STORAGE_KEY, theme);
    setPreference(theme);
  }, []);

  return { preference, resolved, setTheme };
}

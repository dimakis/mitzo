import { compactDisplayResponse } from './compact-display-data';

// The HTML preview has no host storage or service access. Keep all state in memory.
for (const name of ['localStorage', 'sessionStorage']) {
  const values = new Map<string, string>();
  Object.defineProperty(window, name, {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, String(value));
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    },
  });
}
Object.defineProperty(window, 'indexedDB', { value: undefined });
// React and the generated container queries use the same actual preview width.
const nativeMatchMedia = window.matchMedia?.bind(window);
const widthListeners = new Set<() => void>();
new ResizeObserver(() => widthListeners.forEach((notify) => notify())).observe(
  document.getElementById('root')!,
);
window.matchMedia = (query) => {
  const bounds = [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
  if (!bounds.length)
    return (
      nativeMatchMedia?.(query) ?? {
        media: query,
        matches: false,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => true,
      }
    );
  const listeners = new Map<EventListenerOrEventListenerObject, () => void>();
  const matches = () => {
    const width =
      document.getElementById('root')!.clientWidth ||
      Number((window as unknown as { compactDisplayWidth: string }).compactDisplayWidth);
    return bounds.every(([, kind, value]) =>
      kind === 'min' ? width >= Number(value) : width <= Number(value),
    );
  };
  return {
    media: query,
    get matches() {
      return matches();
    },
    onchange: null,
    addEventListener(_type, listener) {
      if (!listener || listeners.has(listener)) return;
      let previous = matches();
      const notify = () => {
        const next = matches();
        if (next === previous) return;
        previous = next;
        const event = new MediaQueryListEvent('change', { matches: next, media: query });
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      };
      listeners.set(listener, notify);
      widthListeners.add(notify);
    },
    removeEventListener(_type, listener) {
      if (!listener) return;
      const notify = listeners.get(listener);
      if (notify) widthListeners.delete(notify);
      listeners.delete(listener);
    },
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  };
};
window.fetch = async (input) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    'https://preview.invalid',
  );
  if (!url.pathname.startsWith('/api/')) throw Error('Preview uses sample data only');
  return new Response(JSON.stringify(compactDisplayResponse(url.pathname, url.searchParams)), {
    headers: { 'Content-Type': 'application/json' },
  });
};
void import('./compact-display');

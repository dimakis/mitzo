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
// A bounded phone preview also uses the phone layout on a desktop window.
window.matchMedia = (query) => {
  const width = Number((window as unknown as { compactDisplayWidth: string }).compactDisplayWidth);
  const min = /min-width:\s*(\d+)px/.exec(query);
  const max = /max-width:\s*(\d+)px/.exec(query);
  return {
    media: query,
    matches: min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
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

import tokens from '../styles/tokens.css?raw';

/** Resolve the shared CSS token for native APIs and browser metadata. */
export function themeBackgroundColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim();
}

/** Persisted seat configuration requires a literal color, not a CSS expression.
 * The default is identity metadata and remains stable across light/dark themes. */
export function defaultSeatColor(): string {
  const match = tokens.match(/--seat-color-default:\s*(#[\da-f]+);/i);
  if (!match) throw new Error('Missing default seat color in theme tokens');
  return match[1];
}

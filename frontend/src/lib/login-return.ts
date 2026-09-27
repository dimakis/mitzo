/** Accept only an app-local destination; login must never become an open redirect. */
export function loginReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';
  try {
    const decoded = decodeURIComponent(value);
    if (
      !decoded.startsWith('/') ||
      decoded.startsWith('//') ||
      decoded.includes('\\') ||
      [...decoded].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      return '/';
    const url = new URL(decoded, 'https://mitzo.invalid');
    if (url.origin !== 'https://mitzo.invalid' || url.pathname === '/login') return '/';
    return value;
  } catch {
    return '/';
  }
}

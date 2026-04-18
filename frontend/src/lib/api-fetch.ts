/**
 * Centralised fetch wrapper for all Mitzo API calls.
 *
 * - Prepends VITE_API_BASE_URL to relative paths (empty for browser same-origin,
 *   full URL for Capacitor iOS builds).
 * - Injects Authorization header when a token is stored in localStorage
 *   (Capacitor auth flow stores JWT there).
 * - Always includes credentials for cookie-based browser auth.
 */

const AUTH_TOKEN_KEY = 'mitzo_auth_token';

export function getApiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL || '';
}

export function getWsBaseUrl(): string {
  const base = getApiBaseUrl();
  if (base) {
    const wsBase = base.replace(/^http/, 'ws');
    const token =
      typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) : null;
    return token ? `${wsBase}` : wsBase;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

/** Build the full WebSocket URL with token auth query param when needed. */
export function getWsChatUrl(): string {
  const base = getWsBaseUrl();
  const token =
    typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) : null;
  const url = `${base}/ws/chat`;
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = path.startsWith('http') ? path : `${getApiBaseUrl()}${path}`;
  const headers = new Headers(init?.headers);
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) : null;
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers, credentials: 'include' });
}

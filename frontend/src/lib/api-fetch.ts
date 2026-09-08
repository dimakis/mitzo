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
const LOGOUT_PENDING_KEY = 'mitzo_logout_pending';
export const AUTH_LOST_EVENT = 'mitzo:auth-lost';
export const AUTH_RESTORED_EVENT = 'mitzo:auth-restored';
let authGeneration = 0;
let authenticationRestored = false;
let cookieRestoreInFlight: Promise<boolean> | null = null;

function dispatchAuthEvent(name: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(name));
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.storageArea && event.storageArea !== localStorage) return;
    if (event.key === AUTH_TOKEN_KEY) {
      authGeneration++;
      authenticationRestored = Boolean(event.newValue);
      dispatchAuthEvent(event.newValue ? AUTH_RESTORED_EVENT : AUTH_LOST_EVENT);
    } else if (event.key === LOGOUT_PENDING_KEY && event.newValue === '1') {
      authGeneration++;
      authenticationRestored = false;
      dispatchAuthEvent(AUTH_LOST_EVENT);
    }
  });
}

export function markAuthLost(): void {
  authGeneration++;
  authenticationRestored = false;
  if (typeof localStorage !== 'undefined') localStorage.removeItem(AUTH_TOKEN_KEY);
  dispatchAuthEvent(AUTH_LOST_EVENT);
}

export function loginSucceeded(token?: string): void {
  const previousToken = getStoredAuthToken();
  const shouldRestore = !authenticationRestored || Boolean(token && token !== previousToken);
  if (token && typeof localStorage !== 'undefined') localStorage.setItem(AUTH_TOKEN_KEY, token);
  if (typeof localStorage !== 'undefined') localStorage.removeItem(LOGOUT_PENDING_KEY);
  if (shouldRestore) {
    authGeneration++;
    authenticationRestored = true;
    dispatchAuthEvent(AUTH_RESTORED_EVENT);
  }
}

export function isLogoutPending(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(LOGOUT_PENDING_KEY) === '1';
}

export function getStoredAuthToken(): string | null {
  return typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) : null;
}

export function getApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  return configured && configured !== 'undefined' ? configured : '';
}

export function getWsBaseUrl(): string {
  const base = getApiBaseUrl();
  if (base) return base.replace(/^http/, 'ws');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

/** Build the full WebSocket URL with token auth query param when needed. */
export function getWsChatUrl(): string {
  const base = getWsBaseUrl();
  const token = getStoredAuthToken();
  const url = `${base}/ws/chat`;
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

/** Build an SSE URL with query authentication for EventSource, which cannot set headers. */
export function getEventSourceUrl(path: string): string {
  const url = path.startsWith('http') ? path : `${getApiBaseUrl()}${path}`;
  const token = getStoredAuthToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = path.startsWith('http') ? path : `${getApiBaseUrl()}${path}`;
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  const requestAuthGeneration = authGeneration;
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers, credentials: 'include' });
  const currentToken = getStoredAuthToken();
  if (
    response.status === 401 &&
    !path.endsWith('/api/auth/login') &&
    currentToken === token &&
    authGeneration === requestAuthGeneration
  ) {
    markAuthLost();
  }
  return response;
}

/** Restore transport authorization when a failed login left a valid cookie session intact. */
export function restoreCookieAuthentication(): Promise<boolean> {
  if (cookieRestoreInFlight) return cookieRestoreInFlight;
  const restoreGeneration = authGeneration;
  const attempt = (async () => {
    const response = await apiFetch('/api/auth/check');
    if (!response.ok || authGeneration !== restoreGeneration || isLogoutPending()) return false;
    loginSucceeded();
    return true;
  })();
  cookieRestoreInFlight = attempt;
  const clear = () => {
    if (cookieRestoreInFlight === attempt) cookieRestoreInFlight = null;
  };
  void attempt.then(clear, clear);
  return attempt;
}

export async function logout(): Promise<void> {
  if (typeof localStorage !== 'undefined') localStorage.setItem(LOGOUT_PENDING_KEY, '1');
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = apiFetch('/api/auth/logout', { method: 'POST', signal: controller.signal });
  // Local logout must not wait on a slow or unreachable server. apiFetch has
  // already captured the current bearer token before this credential removal.
  markAuthLost();
  try {
    const response = await Promise.race([
      request,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, 2_000);
      }),
    ]);
    if (response?.ok) {
      localStorage.removeItem(LOGOUT_PENDING_KEY);
    }
  } catch {
    // Local credential removal must remain available while the server is down.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

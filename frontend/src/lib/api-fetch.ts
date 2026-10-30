import { SharedReadRequests } from './shared-read-requests';
/**
 * Centralised fetch wrapper for all Mitzo API calls.
 *
 * - Prepends VITE_API_BASE_URL to relative paths (empty for browser same-origin,
 *   full URL for Capacitor iOS builds).
 * - Injects Authorization header when a token is stored in localStorage
 *   (Capacitor auth flow stores JWT there).
 * - Always includes credentials for cookie-based browser auth.
 */

import { traceAuthenticationCheck } from './auth-check-tracing';
import { getApiBaseUrl } from './api-base-url';
export { getApiBaseUrl } from './api-base-url';

const AUTH_TOKEN_KEY = 'mitzo_auth_token';
const LOGOUT_PENDING_KEY = 'mitzo_logout_pending';
const AUTH_RESTORED_SIGNAL_KEY = 'mitzo_auth_restored_signal';
export const AUTH_LOST_EVENT = 'mitzo:auth-lost';
export const AUTH_RESTORED_EVENT = 'mitzo:auth-restored';
export const CONVERSATION_JOINING_RECOVERY_PREFIX = 'mitzo-conversation-joining-recovery:';
let authGeneration = 0;
let authenticationRestored = false;
const pendingTelosReads = new SharedReadRequests();
const pendingTodoReads = new Map<string, Promise<Response>>();
const COOKIE_AUTH_VERIFICATION_MS = 30_000;
const COOKIE_AUTH_CHECK_TIMEOUT_MS = 5_000;
let verifiedCookieAuth: {
  generation: number;
  token: string | null;
  expiresAt: number;
  authSessionId?: string;
} | null = null;
let cookieRestoreInFlight: {
  generation: number;
  token: string | null;
  promise: Promise<boolean>;
} | null = null;

/** Fence new list reads from requests started before a refresh or mutation. */
export function invalidateTodoReads(): void {
  pendingTelosReads.retire();
  pendingTodoReads.clear();
}

type AuthEventSource = 'local' | 'cross-tab';

function clearJoiningRecovery(): void {
  try {
    const keys = Object.keys(sessionStorage).filter((key) =>
      key.startsWith(CONVERSATION_JOINING_RECOVERY_PREFIX),
    );
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    // Auth changes still invalidate the verified identity when storage is unavailable.
  }
}

function dispatchAuthEvent(name: string, source: AuthEventSource = 'local'): void {
  pendingTelosReads.clear();
  pendingTodoReads.clear();
  verifiedCookieAuth = null;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(name, { detail: { source } }));
  }
}

export function isCrossTabAuthEvent(event: Event): boolean {
  return (event as CustomEvent<{ source?: unknown }>).detail?.source === 'cross-tab';
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.storageArea && event.storageArea !== localStorage) return;
    if (event.key === AUTH_TOKEN_KEY) {
      clearJoiningRecovery();
      authGeneration++;
      authenticationRestored = Boolean(event.newValue);
      dispatchAuthEvent(event.newValue ? AUTH_RESTORED_EVENT : AUTH_LOST_EVENT, 'cross-tab');
    } else if (event.key === LOGOUT_PENDING_KEY && event.newValue === '1') {
      clearJoiningRecovery();
      authGeneration++;
      authenticationRestored = false;
      dispatchAuthEvent(AUTH_LOST_EVENT, 'cross-tab');
    } else if (
      event.key === AUTH_RESTORED_SIGNAL_KEY &&
      event.newValue &&
      (!authenticationRestored || event.newValue.startsWith('login:'))
    ) {
      if (event.newValue.startsWith('login:')) clearJoiningRecovery();
      authGeneration++;
      authenticationRestored = true;
      dispatchAuthEvent(AUTH_RESTORED_EVENT, 'cross-tab');
    }
  });
}

export function markAuthLost(): void {
  clearJoiningRecovery();
  authGeneration++;
  authenticationRestored = false;
  if (typeof localStorage !== 'undefined') localStorage.removeItem(AUTH_TOKEN_KEY);
  dispatchAuthEvent(AUTH_LOST_EVENT);
}

function restoreAuthenticationLatch(token?: string, explicitLogin = false): void {
  const previousToken = getStoredAuthToken();
  const shouldRestore =
    explicitLogin || !authenticationRestored || Boolean(token && token !== previousToken);
  if (token && typeof localStorage !== 'undefined') localStorage.setItem(AUTH_TOKEN_KEY, token);
  if (typeof localStorage !== 'undefined') localStorage.removeItem(LOGOUT_PENDING_KEY);
  if (shouldRestore) {
    authGeneration++;
    authenticationRestored = true;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        AUTH_RESTORED_SIGNAL_KEY,
        `${explicitLogin ? 'login:' : ''}${authGeneration}:${Date.now()}:${Math.random()}`,
      );
    }
    dispatchAuthEvent(AUTH_RESTORED_EVENT);
  }
}

export function loginSucceeded(token?: string): void {
  clearJoiningRecovery();
  // Explicit login is a new identity selection, including cookie-only logins.
  verifiedCookieAuth = null;
  restoreAuthenticationLatch(token, true);
}

/** Last server-verified login identity for local correlation, never an access grant.
 * A normal reload must verify again before it can select any retained joining state.
 */
export function currentVerifiedAuthSessionId(): string | undefined {
  return !isLogoutPending() &&
    verifiedCookieAuth?.generation === authGeneration &&
    verifiedCookieAuth.token === getStoredAuthToken()
    ? verifiedCookieAuth.authSessionId
    : undefined;
}

export function isLogoutPending(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(LOGOUT_PENDING_KEY) === '1';
}

export function getStoredAuthToken(): string | null {
  return typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) : null;
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
  const request = { ...init, headers, credentials: 'include' as const };
  const isTodoList = path === '/api/todos' || path.startsWith('/api/todos?');
  const shareRead =
    isTodoList &&
    [...new URLSearchParams(path.split('?')[1]).keys()].every((key) => key === 'profile') &&
    (!init?.method || init.method === 'GET') &&
    Object.keys(init ?? {}).every((key) => key === 'method' || key === 'credentials');
  const shareTelosRead =
    /^\/api\/telos\/work\/items\/[^/?]+$/.test(path) &&
    (!init?.method || init.method === 'GET') &&
    Object.keys(init ?? {}).every((key) => ['method', 'credentials', 'signal'].includes(key));
  let response: Response;
  if (shareTelosRead) {
    const key = JSON.stringify([requestAuthGeneration, token, url]);
    response = await pendingTelosReads.read(
      key,
      (signal) => fetch(url, { ...request, signal }),
      init?.signal,
    );
  } else if (shareRead) {
    // Page, Today and badge reads share only outstanding identical requests.
    // Auth generations prevent a new login from joining an old user's request.
    const key = JSON.stringify([requestAuthGeneration, token, url]);
    let pending = pendingTodoReads.get(key);
    if (!pending) {
      pending = fetch(url, request).finally(() => {
        if (pendingTodoReads.get(key) === pending) pendingTodoReads.delete(key);
      });
      pendingTodoReads.set(key, pending);
    }
    response = (await pending).clone();
  } else {
    response = await fetch(url, request);
  }
  if (
    response.ok &&
    (path === '/api/todos' || path.startsWith('/api/todos/')) &&
    init?.method &&
    !['GET', 'HEAD'].includes(init.method.toUpperCase())
  )
    invalidateTodoReads();
  const currentToken = getStoredAuthToken();
  if (
    response.status === 401 &&
    !init?.signal?.aborted &&
    !path.endsWith('/api/auth/login') &&
    currentToken === token &&
    authGeneration === requestAuthGeneration
  ) {
    markAuthLost();
  }
  return response;
}

/** Existing, bounded server proof for a synchronous route render in this login. */
export function hasVerifiedCookieAuthentication(): boolean {
  return Boolean(
    !isLogoutPending() &&
    verifiedCookieAuth?.generation === authGeneration &&
    verifiedCookieAuth.token === getStoredAuthToken() &&
    Date.now() < verifiedCookieAuth.expiresAt,
  );
}

/** Verify cookie authorization; briefly reuse proof across route changes in the same login. */
export function restoreCookieAuthentication(): Promise<boolean> {
  const restoreGeneration = authGeneration;
  const restoreToken = getStoredAuthToken();
  if (isLogoutPending()) return Promise.resolve(false);
  if (hasVerifiedCookieAuthentication()) return Promise.resolve(true);
  if (
    cookieRestoreInFlight?.generation === restoreGeneration &&
    cookieRestoreInFlight.token === restoreToken
  ) {
    return cookieRestoreInFlight.promise;
  }
  const attempt = (async () => {
    const controller = new AbortController();
    let timeout!: ReturnType<typeof setTimeout>;
    // Bound the network check even when the browser does not settle an aborted fetch.
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error('Authentication check timed out'));
        controller.abort();
      }, COOKIE_AUTH_CHECK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        traceAuthenticationCheck(async (span, headers) => {
          if (
            authGeneration !== restoreGeneration ||
            getStoredAuthToken() !== restoreToken ||
            isLogoutPending()
          )
            return false;
          const response = await apiFetch('/api/auth/check', {
            signal: controller.signal,
            headers,
          });
          if (controller.signal.aborted) throw new Error('Authentication check timed out');
          span.setAttribute('http.response.status_code', response.status);
          if (
            authGeneration !== restoreGeneration ||
            getStoredAuthToken() !== restoreToken ||
            isLogoutPending()
          )
            return false;
          if (response.status === 401 || response.status === 403) {
            clearJoiningRecovery();
            verifiedCookieAuth = null;
            return false;
          }
          if (!response.ok) throw new Error('Authentication service unavailable');
          let authSessionId: string | undefined;
          try {
            const body: unknown = await response.json();
            if (
              body &&
              typeof body === 'object' &&
              'authSessionId' in body &&
              typeof body.authSessionId === 'string' &&
              /^\S{1,200}$/.test(body.authSessionId)
            )
              authSessionId = body.authSessionId;
          } catch {
            // Older backends retain ordinary authentication, without durable joining.
          }
          if (controller.signal.aborted) throw new Error('Authentication check timed out');
          if (
            authGeneration !== restoreGeneration ||
            getStoredAuthToken() !== restoreToken ||
            isLogoutPending()
          )
            return false;
          if (
            verifiedCookieAuth?.authSessionId &&
            verifiedCookieAuth.authSessionId !== authSessionId
          )
            clearJoiningRecovery();
          restoreAuthenticationLatch();
          verifiedCookieAuth = {
            generation: authGeneration,
            token: getStoredAuthToken(),
            expiresAt: Date.now() + COOKIE_AUTH_VERIFICATION_MS,
            authSessionId,
          };
          return true;
        }, controller.signal),
        deadline,
      ]);
    } finally {
      clearTimeout(timeout);
    }
  })();
  cookieRestoreInFlight = { generation: restoreGeneration, token: restoreToken, promise: attempt };
  const clear = () => {
    if (cookieRestoreInFlight?.promise === attempt) cookieRestoreInFlight = null;
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

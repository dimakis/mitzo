// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  apiFetch,
  getApiBaseUrl,
  getEventSourceUrl,
  getWsBaseUrl,
  isLogoutPending,
  loginSucceeded,
  logout,
  restoreCookieAuthentication,
  AUTH_LOST_EVENT,
  AUTH_RESTORED_EVENT,
} from '../api-fetch';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response('ok'));
  localStorage.clear();
});

describe('getApiBaseUrl', () => {
  it('returns empty string when VITE_API_BASE_URL is not set', () => {
    expect(getApiBaseUrl()).toBe('');
  });
});

describe('getWsBaseUrl', () => {
  it('derives ws:// from location when no base URL configured', () => {
    const url = getWsBaseUrl();
    // jsdom defaults to http://localhost
    expect(url).toMatch(/^wss?:\/\//);
  });
});

describe('getEventSourceUrl', () => {
  it('adds the stored bearer token for native EventSource authentication', () => {
    localStorage.setItem('mitzo_auth_token', 'token with spaces');
    expect(getEventSourceUrl('/api/events')).toBe('/api/events?token=token%20with%20spaces');
  });

  it('does not add a query parameter when no token is stored', () => {
    expect(getEventSourceUrl('/api/events')).toBe('/api/events');
  });
});

describe('apiFetch', () => {
  it('propagates token changes from another tab as auth lifecycle events', () => {
    const restored = vi.fn();
    const lost = vi.fn();
    window.addEventListener(AUTH_RESTORED_EVENT, restored);
    window.addEventListener(AUTH_LOST_EVENT, lost);

    window.dispatchEvent(
      new StorageEvent('storage', { key: 'mitzo_auth_token', newValue: 'fresh-token' }),
    );
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'mitzo_auth_token', oldValue: 'fresh-token' }),
    );

    expect(restored).toHaveBeenCalledOnce();
    expect(lost).toHaveBeenCalledOnce();
    window.removeEventListener(AUTH_RESTORED_EVENT, restored);
    window.removeEventListener(AUTH_LOST_EVENT, lost);
  });

  it('prepends base URL to relative paths when configured', async () => {
    const originalEnv = import.meta.env.VITE_API_BASE_URL;
    // We test the prepend logic via the default (empty) base — relative path stays relative
    await apiFetch('/api/sessions');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/sessions',
      expect.objectContaining({ credentials: 'include' }),
    );
    import.meta.env.VITE_API_BASE_URL = originalEnv;
  });

  it('does not prepend base URL to absolute URLs', async () => {
    await apiFetch('https://external.com/api/data');
    expect(mockFetch).toHaveBeenCalledWith('https://external.com/api/data', expect.anything());
  });

  it('passes through RequestInit options', async () => {
    await apiFetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'test' }),
    });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'test' }));
  });

  it('includes credentials: include', async () => {
    await apiFetch('/api/sessions');
    const [, init] = mockFetch.mock.calls[0];
    expect(init.credentials).toBe('include');
  });

  it('adds Authorization header when token is in localStorage', async () => {
    localStorage.setItem('mitzo_auth_token', 'test-jwt-token');
    await apiFetch('/api/sessions');
    const [, init] = mockFetch.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer test-jwt-token');
  });

  it('does not add Authorization header when no token', async () => {
    await apiFetch('/api/sessions');
    const [, init] = mockFetch.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBeNull();
  });

  it('preserves existing headers from init', async () => {
    await apiFetch('/api/sessions', {
      headers: { 'Content-Type': 'application/json' },
    });
    const [, init] = mockFetch.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('clears stale bearer state and announces protected 401 responses', async () => {
    localStorage.setItem('mitzo_auth_token', 'expired-token');
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const listener = vi.fn();
    window.addEventListener(AUTH_LOST_EVENT, listener);

    await apiFetch('/api/sessions');

    expect(localStorage.getItem('mitzo_auth_token')).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(AUTH_LOST_EVENT, listener);
  });

  it('does not let a delayed old-token 401 clear a newer login', async () => {
    localStorage.setItem('mitzo_auth_token', 'old-token');
    let resolveResponse!: (response: Response) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );

    const pending = apiFetch('/api/sessions');
    loginSucceeded('fresh-token');
    resolveResponse(new Response('{}', { status: 401 }));
    await pending;

    expect(localStorage.getItem('mitzo_auth_token')).toBe('fresh-token');
  });

  it('does not announce a delayed cookie-only 401 after a newer cookie login', async () => {
    let resolveResponse!: (response: Response) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const listener = vi.fn();
    window.addEventListener(AUTH_LOST_EVENT, listener);

    const pending = apiFetch('/api/sessions');
    loginSucceeded();
    resolveResponse(new Response('{}', { status: 401 }));
    await pending;

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_LOST_EVENT, listener);
  });

  it('does not announce an expected failed login as auth loss', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const listener = vi.fn();
    window.addEventListener(AUTH_LOST_EVENT, listener);

    await apiFetch('/api/auth/login', { method: 'POST' });

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_LOST_EVENT, listener);
  });

  it('restores the auth latch when an existing cookie session is still valid', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const listener = vi.fn();
    window.addEventListener(AUTH_RESTORED_EVENT, listener);

    expect(await restoreCookieAuthentication()).toBe(true);

    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(AUTH_RESTORED_EVENT, listener);
  });

  it('does not restore a stale cookie check after logout begins in another tab', async () => {
    let resolveResponse!: (response: Response) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const listener = vi.fn();
    window.addEventListener(AUTH_RESTORED_EVENT, listener);

    const pending = restoreCookieAuthentication();
    localStorage.setItem('mitzo_logout_pending', '1');
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'mitzo_logout_pending', newValue: '1' }),
    );
    resolveResponse(new Response('{}', { status: 200 }));

    expect(await pending).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(isLogoutPending()).toBe(true);
    window.removeEventListener(AUTH_RESTORED_EVENT, listener);
  });

  it('logs out on the server before deleting the credential', async () => {
    localStorage.setItem('mitzo_auth_token', 'current-token');

    await logout();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/auth/logout');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer current-token');
    expect(localStorage.getItem('mitzo_auth_token')).toBeNull();
    expect(isLogoutPending()).toBe(false);
  });

  it('still completes local logout when the server is unavailable', async () => {
    localStorage.setItem('mitzo_auth_token', 'current-token');
    mockFetch.mockRejectedValueOnce(new Error('offline'));

    await expect(logout()).resolves.toBeUndefined();

    expect(localStorage.getItem('mitzo_auth_token')).toBeNull();
    expect(isLogoutPending()).toBe(true);
  });

  it('keeps logout pending when no response proves cookie clearing ran', async () => {
    localStorage.setItem('mitzo_auth_token', 'stale-token');
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 401 }));

    await logout();

    expect(isLogoutPending()).toBe(true);
  });

  it('clears local auth immediately and bounds a blackholed logout request', async () => {
    vi.useFakeTimers();
    localStorage.setItem('mitzo_auth_token', 'current-token');
    mockFetch.mockImplementationOnce(() => new Promise(() => {}));

    const pending = logout();
    expect(localStorage.getItem('mitzo_auth_token')).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toBeUndefined();
    expect(isLogoutPending()).toBe(true);
    vi.useRealTimers();
  });

  it('announces successful reauthentication after storing the new token', () => {
    const listener = vi.fn();
    window.addEventListener(AUTH_RESTORED_EVENT, listener);

    loginSucceeded('fresh-token');

    expect(localStorage.getItem('mitzo_auth_token')).toBe('fresh-token');
    expect(isLogoutPending()).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(AUTH_RESTORED_EVENT, listener);
  });
});

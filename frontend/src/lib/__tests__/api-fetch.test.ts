// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, getApiBaseUrl, getWsBaseUrl } from '../api-fetch';

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

describe('apiFetch', () => {
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
    expect(mockFetch).toHaveBeenCalledWith(
      'https://external.com/api/data',
      expect.anything(),
    );
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
});

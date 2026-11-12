// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { shareFile } from '../share-file';
import { shareNativeFile } from '../native-file-share';
vi.mock('../native-file-share', () => ({ shareNativeFile: vi.fn(async () => true) }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});
it('fetches retained handover bytes from the configured server with bearer auth before native sharing', async () => {
  vi.stubEnv('VITE_API_BASE_URL', 'https://mitzo.example');
  vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
  localStorage.setItem('mitzo_auth_token', 'offline-test-token');
  const text = '# Handover\n\nClaude’s personal subscription. 🔧';
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Disposition': 'attachment; filename="handover.md"' }),
    blob: async () => new Blob([text], { type: 'text/markdown' }),
  }));
  vi.stubGlobal('fetch', fetch);
  const url = '/api/session-launch/requests/d712cf36-9659-48e8-8cb0-9d542a7bb200/handover.md';
  expect(await shareFile(url)).toBe(true);
  expect(fetch).toHaveBeenCalledWith(
    'https://mitzo.example' + url,
    expect.objectContaining({ credentials: 'include' }),
  );
  const options = fetch.mock.calls[0][1] as RequestInit;
  expect(new Headers(options.headers).get('Authorization')).toBe('Bearer offline-test-token');
  const file = vi.mocked(shareNativeFile).mock.calls.at(-1)![0];
  expect(file.name).toBe('handover.md');
  expect(file.type).toBe('text/markdown');
  const bytes = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(file);
  });
  expect(bytes).toBe(text);
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureBackups, getBackupSetup, prepareBackups } from '../backups-api';
import { apiFetch, getApiBaseUrl } from '../api-fetch';
vi.mock('../api-fetch', () => ({ apiFetch: vi.fn(), getApiBaseUrl: vi.fn() }));
beforeEach(() => {
  vi.mocked(getApiBaseUrl).mockReturnValue('');
  vi.mocked(apiFetch).mockImplementation(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('location', new URL('https://mitzo.example/settings/backups'));
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it('rejects remote HTTP before making any request containing the password', async () => {
  vi.stubGlobal('location', new URL('http://mitzo.example/settings/backups'));
  await expect(configureBackups('synthetic-recovery-password')).rejects.toThrow('HTTPS');
  expect(apiFetch).not.toHaveBeenCalled();
});
it('checks the actual Capacitor API target rather than the page scheme', async () => {
  vi.stubGlobal('location', new URL('capacitor://localhost/settings/backups'));
  vi.mocked(getApiBaseUrl).mockReturnValue('http://mitzo.example');
  await expect(configureBackups('synthetic-recovery-password')).rejects.toThrow('HTTPS');
  expect(apiFetch).not.toHaveBeenCalled();
  vi.mocked(getApiBaseUrl).mockReturnValue('https://mitzo.example');
  await configureBackups('synthetic-recovery-password');
  expect(apiFetch).toHaveBeenCalledWith(
    'https://mitzo.example/api/backups/setup',
    expect.objectContaining({ redirect: 'error', method: 'POST' }),
  );
});
it.each([
  'http://localhost:3190',
  'http://mitzo-staging.localhost:3190',
  'http://127.0.0.1:3190',
  'http://[::1]:3190',
])('allows the explicit local-development target %s', async (base) => {
  vi.stubGlobal('location', new URL(base + '/settings/backups'));
  await configureBackups('synthetic-recovery-password');
  expect(apiFetch).toHaveBeenCalledWith(
    base + '/api/backups/setup',
    expect.objectContaining({ redirect: 'error' }),
  );
});
it.each(['http://localhost.example', 'http://127.0.0.1.example', 'ftp://mitzo.example'])(
  'rejects insecure non-loopback or unsupported API target %s',
  async (base) => {
    vi.mocked(getApiBaseUrl).mockReturnValue(base);
    await expect(configureBackups('synthetic-recovery-password')).rejects.toThrow('HTTPS');
    expect(apiFetch).not.toHaveBeenCalled();
  },
);
it('keeps preparation and metadata reads independent of secret transport requirements', async () => {
  vi.stubGlobal('location', new URL('http://mitzo.example/settings/backups'));
  await getBackupSetup();
  await prepareBackups();
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

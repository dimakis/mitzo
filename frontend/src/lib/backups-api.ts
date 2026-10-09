import type { BackupOverview, BackupSetupOverview } from '@mitzo/protocol';
import { apiFetch, getApiBaseUrl } from './api-fetch';
export async function getBackups(): Promise<BackupOverview> {
  const response = await apiFetch('/api/backups');
  if (!response.ok) throw Error('Backup status unavailable');
  return response.json();
}
function secureSetupUrl() {
  try {
    const url = new URL(`${getApiBaseUrl()}/api/backups/setup`, location.href);
    const localHttp =
      url.protocol === 'http:' &&
      /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9.-]+\.localhost)$/i.test(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) throw Error();
    return url.href;
  } catch {
    throw Error('Open Mitzo over HTTPS before entering a backup password.');
  }
}
async function setupRequest(
  path: string,
  body?: object,
  secret = false,
): Promise<BackupSetupOverview> {
  // Resolve and freeze the actual API target before serializing or transmitting a secret.
  // Capacitor's page origin is independent of VITE_API_BASE_URL.
  const target = secret ? secureSetupUrl() : '/api/backups/setup' + path;
  const response = await apiFetch(
    target,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          ...(secret ? { redirect: 'error' as const } : {}),
        }
      : undefined,
  );
  const data = await response.json();
  if (!response.ok)
    throw Error(typeof data.error === 'string' ? data.error : 'Backup setup unavailable. Retry.');
  return data;
}
export const getBackupSetup = () => setupRequest('');
export const prepareBackups = () => setupRequest('/prepare', {});
export const configureBackups = (password: string) =>
  setupRequest('', { password, recoveryConfirmed: true }, true);
export async function backupAction(action: 'run' | 'refresh'): Promise<void> {
  const response = await apiFetch(`/api/backups/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw Error('Backup unavailable or busy. Check setup and status.');
}

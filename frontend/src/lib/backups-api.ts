import type { BackupOverview, BackupSetupOverview } from '@mitzo/protocol';
import { apiFetch } from './api-fetch';
export async function getBackups(): Promise<BackupOverview> {
  const response = await apiFetch('/api/backups');
  if (!response.ok) throw Error('Backup status unavailable');
  return response.json();
}
async function setupRequest(path: string, body?: object): Promise<BackupSetupOverview> {
  const response = await apiFetch(
    '/api/backups/setup' + path,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
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
  setupRequest('', { password, recoveryConfirmed: true });
export async function backupAction(action: 'run' | 'refresh'): Promise<void> {
  const response = await apiFetch(`/api/backups/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw Error('Backup unavailable or busy. Check setup and status.');
}

import type { BackupOverview } from '@mitzo/protocol';
import { apiFetch } from './api-fetch';
export async function getBackups(): Promise<BackupOverview> {
  const response = await apiFetch('/api/backups');
  if (!response.ok) throw Error('Backup status unavailable');
  return response.json();
}
export async function backupAction(action: 'run' | 'refresh'): Promise<void> {
  const response = await apiFetch(`/api/backups/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw Error('Backup unavailable or busy. Check setup and status.');
}

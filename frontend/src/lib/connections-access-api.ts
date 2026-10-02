import { apiFetch } from './api-fetch';
import type { ConnectionsAccessInventory } from '../types/connections-access';

export async function getConnectionsAccess(
  signal?: AbortSignal,
): Promise<ConnectionsAccessInventory> {
  const response = await apiFetch('/api/connections-access', { signal });
  if (!response.ok) throw new Error('Connections & access could not be loaded.');
  return response.json();
}

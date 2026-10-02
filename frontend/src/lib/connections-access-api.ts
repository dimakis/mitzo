import { apiFetch } from './api-fetch';
import type { ConnectionsAccessInventory } from '../types/connections-access';

export async function getConnectionsAccess(
  signal?: AbortSignal,
): Promise<ConnectionsAccessInventory> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => {
      clearTimeout(timeout);
      controller.abort();
      reject(new DOMException('Inventory load cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('Connections & access could not be loaded.'));
    }, 15_000);
  });
  try {
    if (signal?.aborted) return await cancelled;
    const load = async () => {
      const response = await apiFetch('/api/connections-access', { signal: controller.signal });
      if (!response.ok) throw new Error('Connections & access could not be loaded.');
      return response.json() as Promise<ConnectionsAccessInventory>;
    };
    // Also bound transports or response bodies that do not settle after abort.
    return await Promise.race([load(), cancelled]);
  } finally {
    clearTimeout(timeout);
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}

import { PrMonitorInventorySchema, type PrMonitorInventory } from '@mitzo/protocol';
import { apiFetch } from './api-fetch';

export function prMonitorPath(sessionId: string) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/access-grants`;
}

export async function readPrMonitors(
  sessionId: string,
  signal?: AbortSignal,
): Promise<PrMonitorInventory> {
  const response = await apiFetch(`${prMonitorPath(sessionId)}/pr-monitor`, { signal });
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'PR status access is unavailable. Sign in and refresh.'
        : 'PR status could not be checked. Retained evidence may be stale.',
    );
  const parsed = PrMonitorInventorySchema.safeParse(await response.json());
  if (
    !parsed.success ||
    parsed.data.subscriptions.some((p) => p.subscription.conversationId !== sessionId)
  )
    throw new Error('PR status response could not be verified. Refresh to try again.');
  return parsed.data;
}

export async function changePrMonitor(
  sessionId: string,
  path: string,
  body: object,
  signal?: AbortSignal,
) {
  const response = await apiFetch(`${prMonitorPath(sessionId)}${path}`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'X-Mitzo-Access-Intent': 'manage-grants' },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error('The change was not confirmed. Refresh status before another action.');
  return response.json() as Promise<unknown>;
}

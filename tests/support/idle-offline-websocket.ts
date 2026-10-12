import type { WebSocketRoute } from '@playwright/test';

/** An idle v2 fixture peer: no backend, execution or artificial reconnect loop. */
export function keepIdleOfflineWebSocket(route: WebSocketRoute, onWelcome?: () => void): void {
  route.onMessage((raw) => {
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (
      typeof message !== 'object' ||
      message === null ||
      !('type' in message) ||
      message.type !== 'hello' ||
      !('protocolVersion' in message) ||
      message.protocolVersion !== 2
    )
      return;
    route.send(
      JSON.stringify({ type: 'welcome', protocolVersion: 2, connectionId: 'offline-drafts' }),
    );
    onWelcome?.();
  });
}

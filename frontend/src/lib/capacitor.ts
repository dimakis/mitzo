/**
 * Capacitor-specific lifecycle integration.
 *
 * When running as a native iOS app, registers appStateChange listener
 * to trigger document visibilitychange — which MitzoConnection already
 * listens for to force WebSocket reconnection. This piggybacks on the
 * existing reconnect logic rather than requiring a direct connection ref.
 */

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

export function isCapacitor(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Register Capacitor app lifecycle events. When the app returns to the
 * foreground, calls the provided callback to force a WebSocket reconnect
 * check. This directly invokes MitzoConnection.checkAndReconnect() rather
 * than relying on synthetic visibilitychange events (which won't update
 * the read-only document.visibilityState property).
 *
 * Call once at app startup. No-op in browser environments.
 */
export function registerCapacitorLifecycle(onResume: () => void): void {
  if (!isCapacitor()) return;

  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) onResume();
  });
}

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
 * foreground, dispatches a visibilitychange event so MitzoConnection's
 * existing browser listeners trigger reconnection.
 *
 * Call once at app startup. No-op in browser environments.
 */
export function registerCapacitorLifecycle(): void {
  if (!isCapacitor()) return;

  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive && typeof document !== 'undefined') {
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
}

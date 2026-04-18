/**
 * Capacitor-specific lifecycle integration.
 *
 * When running as a native iOS app, registers appStateChange listener
 * to force WebSocket reconnection when the app returns to the foreground.
 * This replaces the browser's visibilitychange/pageshow events which may
 * not fire reliably in WKWebView.
 */

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import type { MitzoConnection } from '@mitzo/client';

export function isCapacitor(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Wire Capacitor app lifecycle events to MitzoConnection reconnect.
 * Call once after creating the store. No-op in browser environments.
 */
export function registerCapacitorLifecycle(connection: MitzoConnection): void {
  if (!isCapacitor()) return;

  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) {
      connection.checkAndReconnect();
    }
  });
}

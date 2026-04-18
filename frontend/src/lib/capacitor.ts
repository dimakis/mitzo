/**
 * Capacitor-specific lifecycle integration.
 *
 * When running as a native iOS app, registers appStateChange listener
 * to force a WebSocket reconnect check on resume. The callback directly
 * invokes MitzoConnection.checkAndReconnect() via the store rather than
 * relying on synthetic DOM events.
 */

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';

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

/**
 * Configure the native status bar appearance. Sets light text on the dark
 * app background (#0f0f1a) so the status bar blends with the UI.
 *
 * No-op in browser environments.
 */
export async function configureStatusBar(): Promise<void> {
  if (!isCapacitor()) return;

  await StatusBar.setStyle({ style: Style.Dark });
  await StatusBar.setBackgroundColor({ color: '#0f0f1a' });
}

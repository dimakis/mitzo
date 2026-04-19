// Capacitor-specific lifecycle integration for native iOS.

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';

export function isCapacitor(): boolean {
  return Capacitor.isNativePlatform();
}

/** Register app lifecycle events. Calls onResume on foreground return. No-op in browser. */
export function registerCapacitorLifecycle(onResume: () => void): void {
  if (!isCapacitor()) return;

  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) onResume();
  });
}

/** Configure native status bar — light text on dark background. No-op in browser. */
export async function configureStatusBar(): Promise<void> {
  if (!isCapacitor()) return;

  await StatusBar.setStyle({ style: Style.Dark });
  await StatusBar.setBackgroundColor({ color: '#0f0f1a' });
}

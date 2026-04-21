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

/** Configure native status bar to match theme. No-op in browser. */
export async function configureStatusBar(theme: 'dark' | 'light' = 'dark'): Promise<void> {
  if (!isCapacitor()) return;

  await StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light });
  await StatusBar.setBackgroundColor({ color: theme === 'dark' ? '#111113' : '#f5f5f7' });
}

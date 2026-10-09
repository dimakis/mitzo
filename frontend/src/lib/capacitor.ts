// Capacitor-specific lifecycle integration for native iOS.

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { themeBackgroundColor } from './theme-color';

export function isCapacitor(): boolean {
  return Capacitor.isNativePlatform();
}

/** Register app lifecycle events. Calls onResume on foreground return, onPause on background. No-op in browser. */
export function registerCapacitorLifecycle(onResume: () => void, onPause?: () => void): void {
  if (!isCapacitor()) return;

  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) {
      onResume();
    } else {
      onPause?.();
    }
  });
}

/** Configure native status bar to match theme. No-op in browser. */
export async function configureStatusBar(theme: 'dark' | 'light' = 'dark'): Promise<void> {
  if (!isCapacitor()) return;

  await StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light });
  const color = themeBackgroundColor();
  if (color) await StatusBar.setBackgroundColor({ color });
}

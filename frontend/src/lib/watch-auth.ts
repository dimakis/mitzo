// Bridges web auth tokens into the native shared Keychain for Apple Watch.
// Calls the WatchAuthBridge Capacitor plugin on iOS; no-ops on web/Android.

import { Capacitor, registerPlugin } from '@capacitor/core';

interface WatchAuthBridgePlugin {
  saveToken(options: { token: string }): Promise<void>;
  clearToken(): Promise<void>;
}

const WatchAuthBridge = registerPlugin<WatchAuthBridgePlugin>('WatchAuthBridge');

export async function saveTokenToWatch(token: string): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') return;
  try {
    await WatchAuthBridge.saveToken({ token });
  } catch {
    // Plugin not available or save failed — non-fatal
  }
}

export async function clearWatchToken(): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') return;
  try {
    await WatchAuthBridge.clearToken();
  } catch {
    // Plugin not available — non-fatal
  }
}

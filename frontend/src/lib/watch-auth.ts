// Bridges web auth tokens into the native shared Keychain for Apple Watch.
// Calls the WatchAuthBridge Capacitor plugin on iOS; no-ops on web/Android.

import { Capacitor, registerPlugin } from '@capacitor/core';

interface WatchAuthBridgePlugin {
  saveToken(options: { token: string }): Promise<void>;
  clearToken(): Promise<void>;
}

let watchAuthBridge: WatchAuthBridgePlugin | undefined;
function bridge(): WatchAuthBridgePlugin {
  return (watchAuthBridge ??= registerPlugin<WatchAuthBridgePlugin>('WatchAuthBridge'));
}

export async function saveTokenToWatch(token: string): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') return;
  try {
    await bridge().saveToken({ token });
  } catch {
    // Plugin not available or save failed — non-fatal
  }
}

export async function clearWatchToken(): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') return;
  try {
    await bridge().clearToken();
  } catch {
    // Plugin not available — non-fatal
  }
}

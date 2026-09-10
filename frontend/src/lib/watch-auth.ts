// Bridges web auth tokens into the native shared Keychain for Apple Watch.
// Calls the WatchAuthBridge Capacitor plugin on iOS; no-ops on web/Android.

import { Capacitor, registerPlugin } from '@capacitor/core';

interface WatchAuthBridgePlugin {
  saveToken(options: { token: string }): Promise<void>;
  clearToken(): Promise<void>;
}

let watchAuthBridge: WatchAuthBridgePlugin | undefined;
let watchMutation = Promise.resolve();
function bridge(): WatchAuthBridgePlugin {
  return (watchAuthBridge ??= registerPlugin<WatchAuthBridgePlugin>('WatchAuthBridge'));
}

function enqueueWatchMutation(operation: () => Promise<void>): Promise<void> {
  const next = watchMutation.then(operation, operation);
  watchMutation = next.catch(() => undefined);
  return next;
}

export async function saveTokenToWatch(token: string): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') return;
  await enqueueWatchMutation(async () => {
    try {
      await bridge().saveToken({ token });
    } catch {
      // Plugin not available or save failed — non-fatal
    }
  });
}

export async function clearWatchToken(): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') return;
  await enqueueWatchMutation(async () => {
    try {
      await bridge().clearToken();
    } catch {
      // Plugin not available — non-fatal
    }
  });
}

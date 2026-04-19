import { Capacitor } from '@capacitor/core';
import { SplashScreen } from '@capacitor/splash-screen';

/** Hide the native splash screen once the app has initialized. No-op in browser. */
export async function hideSplash(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await SplashScreen.hide({ fadeOutDuration: 300 });
}

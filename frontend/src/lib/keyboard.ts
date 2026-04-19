import { Capacitor } from '@capacitor/core';
import { Keyboard, KeyboardResize } from '@capacitor/keyboard';

/** Configure native keyboard behavior. No-op in browser. */
export async function configureKeyboard(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  await Keyboard.setResizeMode({ mode: KeyboardResize.Native });
  await Keyboard.setAccessoryBarVisible({ isVisible: false });
}

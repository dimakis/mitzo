import { Capacitor } from '@capacitor/core';
import { Keyboard, KeyboardResize } from '@capacitor/keyboard';

/** Configure native keyboard behavior. No-op in browser. */
export async function configureKeyboard(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  await Keyboard.setResizeMode({ mode: KeyboardResize.Native });
  await Keyboard.setAccessoryBarVisible({ isVisible: false });
}

/** Register keyboard show/hide listeners. Returns cleanup function. No-op in browser. */
export function onKeyboardToggle(callback: (visible: boolean) => void): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};

  const showHandle = Keyboard.addListener('keyboardWillShow', () => callback(true));
  const hideHandle = Keyboard.addListener('keyboardWillHide', () => callback(false));

  return () => {
    showHandle.then((h) => h.remove());
    hideHandle.then((h) => h.remove());
  };
}

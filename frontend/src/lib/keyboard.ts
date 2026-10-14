import { Capacitor } from '@capacitor/core';
import { Keyboard, KeyboardResize } from '@capacitor/keyboard';

/** Configure native keyboard behavior. No-op in browser. */
export async function configureKeyboard(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  await Keyboard.setResizeMode({ mode: KeyboardResize.Native });
  await Keyboard.setAccessoryBarVisible({ isVisible: false });
  await Keyboard.setScroll({ isDisabled: true });
}

/** Observe native keyboard events or the browser visual viewport. */
export function onKeyboardToggle(callback: (visible: boolean) => void): () => void {
  if (!Capacitor.isNativePlatform()) {
    if (typeof window === 'undefined' || !window.visualViewport) return () => {};
    const viewport = window.visualViewport;
    let disposed = false;
    let previous: boolean | undefined;
    const measure = () => {
      if (disposed) return;
      const layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
      const editable = document.activeElement?.matches('textarea, input, [contenteditable="true"]');
      // Ordinary browser chrome and pinch zoom must not move the chat/navigation.
      const visible =
        !!editable &&
        viewport.scale === 1 &&
        layoutHeight - viewport.height > Math.max(100, layoutHeight * 0.15);
      if (visible !== previous) {
        previous = visible;
        callback(visible);
      }
    };
    const afterFocus = () => queueMicrotask(measure);
    viewport.addEventListener('resize', measure);
    document.addEventListener('focusin', measure);
    document.addEventListener('focusout', afterFocus);
    measure();
    return () => {
      disposed = true;
      viewport.removeEventListener('resize', measure);
      document.removeEventListener('focusin', measure);
      document.removeEventListener('focusout', afterFocus);
    };
  }

  const showHandle = Keyboard.addListener('keyboardWillShow', () => callback(true));
  const hideHandle = Keyboard.addListener('keyboardWillHide', () => callback(false));

  return () => {
    showHandle.then((h) => h.remove());
    hideHandle.then((h) => h.remove());
  };
}

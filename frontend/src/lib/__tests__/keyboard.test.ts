import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn() },
}));

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    setResizeMode: vi.fn(),
    setAccessoryBarVisible: vi.fn(),
    setScroll: vi.fn(),
    addListener: vi.fn(),
  },
  KeyboardResize: { Ionic: 'ionic', Native: 'native' },
}));

import { Capacitor } from '@capacitor/core';
import { Keyboard, KeyboardResize } from '@capacitor/keyboard';
import { configureKeyboard, onKeyboardToggle } from '../keyboard';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('configureKeyboard', () => {
  it('no-ops in browser environment', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await configureKeyboard();
    expect(Keyboard.setResizeMode).not.toHaveBeenCalled();
  });

  it('configures native resize mode on native platform', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await configureKeyboard();
    expect(Keyboard.setResizeMode).toHaveBeenCalledWith({ mode: KeyboardResize.Native });
  });

  it('hides accessory bar on native platform', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await configureKeyboard();
    expect(Keyboard.setAccessoryBarVisible).toHaveBeenCalledWith({ isVisible: false });
  });
});

describe('onKeyboardToggle', () => {
  it('returns a no-op cleanup in browser environment', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    const callback = vi.fn();
    const cleanup = onKeyboardToggle(callback);
    expect(Keyboard.addListener).not.toHaveBeenCalled();
    // cleanup should be callable without error
    cleanup();
  });

  it('registers show and hide listeners on native platform', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const removeFn = vi.fn();
    vi.mocked(Keyboard.addListener).mockReturnValue(Promise.resolve({ remove: removeFn }));

    const callback = vi.fn();
    onKeyboardToggle(callback);

    expect(Keyboard.addListener).toHaveBeenCalledTimes(2);
    expect(Keyboard.addListener).toHaveBeenCalledWith('keyboardWillShow', expect.any(Function));
    expect(Keyboard.addListener).toHaveBeenCalledWith('keyboardWillHide', expect.any(Function));
  });

  it('calls callback with true on keyboardWillShow', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let showHandler: (...args: any[]) => void = () => {};
    vi.mocked(Keyboard.addListener).mockImplementation((event, handler) => {
      if (event === 'keyboardWillShow') showHandler = handler;
      return Promise.resolve({ remove: vi.fn() });
    });

    const callback = vi.fn();
    onKeyboardToggle(callback);
    showHandler();

    expect(callback).toHaveBeenCalledWith(true);
  });

  it('calls callback with false on keyboardWillHide', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let hideHandler: (...args: any[]) => void = () => {};
    vi.mocked(Keyboard.addListener).mockImplementation((event, handler) => {
      if (event === 'keyboardWillHide') hideHandler = handler;
      return Promise.resolve({ remove: vi.fn() });
    });

    const callback = vi.fn();
    onKeyboardToggle(callback);
    hideHandler();

    expect(callback).toHaveBeenCalledWith(false);
  });

  it('cleanup removes both listeners', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const removeShow = vi.fn();
    const removeHide = vi.fn();
    let callCount = 0;
    vi.mocked(Keyboard.addListener).mockImplementation(() => {
      callCount++;
      return Promise.resolve({ remove: callCount === 1 ? removeShow : removeHide });
    });

    const cleanup = onKeyboardToggle(vi.fn());
    cleanup();

    // Allow promises to resolve
    await new Promise((r) => setTimeout(r, 0));

    expect(removeShow).toHaveBeenCalled();
    expect(removeHide).toHaveBeenCalled();
  });
});

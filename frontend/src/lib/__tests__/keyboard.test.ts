import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn() },
}));

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    setResizeMode: vi.fn(),
    setAccessoryBarVisible: vi.fn(),
    setScroll: vi.fn(),
  },
  KeyboardResize: { Ionic: 'ionic' },
}));

import { Capacitor } from '@capacitor/core';
import { Keyboard, KeyboardResize } from '@capacitor/keyboard';
import { configureKeyboard } from '../keyboard';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('configureKeyboard', () => {
  it('no-ops in browser environment', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await configureKeyboard();
    expect(Keyboard.setResizeMode).not.toHaveBeenCalled();
  });

  it('configures resize mode on native platform', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await configureKeyboard();
    expect(Keyboard.setResizeMode).toHaveBeenCalledWith({ mode: KeyboardResize.Ionic });
  });

  it('hides accessory bar on native platform', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await configureKeyboard();
    expect(Keyboard.setAccessoryBarVisible).toHaveBeenCalledWith({ isVisible: false });
  });

  it('disables scroll on native platform', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await configureKeyboard();
    expect(Keyboard.setScroll).toHaveBeenCalledWith({ isDisabled: true });
  });
});

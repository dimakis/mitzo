import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn() },
}));

vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: {
    hide: vi.fn(),
  },
}));

import { Capacitor } from '@capacitor/core';
import { SplashScreen } from '@capacitor/splash-screen';
import { hideSplash } from '../splash';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('hideSplash', () => {
  it('no-ops in browser', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await hideSplash();
    expect(SplashScreen.hide).not.toHaveBeenCalled();
  });

  it('hides splash with fade on native platform', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await hideSplash();
    expect(SplashScreen.hide).toHaveBeenCalledWith({ fadeOutDuration: 300 });
  });
});

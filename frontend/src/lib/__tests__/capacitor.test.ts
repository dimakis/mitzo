// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @capacitor/core
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
  },
}));

// Mock @capacitor/app — capture the listener callback
const listeners: Record<string, (data: unknown) => void> = {};
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((event: string, cb: (data: unknown) => void) => {
      listeners[event] = cb;
    }),
  },
}));

// Mock @capacitor/status-bar
vi.mock('@capacitor/status-bar', () => ({
  StatusBar: {
    setStyle: vi.fn().mockResolvedValue(undefined),
    setBackgroundColor: vi.fn().mockResolvedValue(undefined),
  },
  Style: {
    Dark: 'DARK',
    Light: 'LIGHT',
  },
}));

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { isCapacitor, registerCapacitorLifecycle, configureStatusBar } from '../capacitor';

beforeEach(() => {
  vi.clearAllMocks();
  delete listeners['appStateChange'];
});

describe('isCapacitor', () => {
  it('returns false in browser environment', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(isCapacitor()).toBe(false);
  });

  it('returns true on native platform', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    expect(isCapacitor()).toBe(true);
  });
});

describe('registerCapacitorLifecycle', () => {
  it('no-ops in browser environment', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    const onResume = vi.fn();
    registerCapacitorLifecycle(onResume);
    expect(App.addListener).not.toHaveBeenCalled();
  });

  it('registers appStateChange listener on native platform', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const onResume = vi.fn();
    registerCapacitorLifecycle(onResume);
    expect(App.addListener).toHaveBeenCalledWith('appStateChange', expect.any(Function));
  });

  it('calls onResume when app becomes active', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const onResume = vi.fn();
    registerCapacitorLifecycle(onResume);

    // Simulate app returning to foreground
    listeners['appStateChange']({ isActive: true });
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('does not call onResume when app goes to background', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const onResume = vi.fn();
    registerCapacitorLifecycle(onResume);

    // Simulate app going to background
    listeners['appStateChange']({ isActive: false });
    expect(onResume).not.toHaveBeenCalled();
  });
});

describe('configureStatusBar', () => {
  it('no-ops in browser environment', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await configureStatusBar();
    expect(StatusBar.setStyle).not.toHaveBeenCalled();
  });

  it('sets dark style (light text) on native platform', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await configureStatusBar();
    expect(StatusBar.setStyle).toHaveBeenCalledWith({ style: Style.Dark });
  });

  it('sets background color on native platform', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await configureStatusBar();
    expect(StatusBar.setBackgroundColor).toHaveBeenCalledWith({
      color: '#0f0f1a',
    });
  });
});

import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: 'web',
  registerPlugin: vi.fn(() => ({
    saveToken: vi.fn().mockResolvedValue(undefined),
    clearToken: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => mocks.platform !== 'web',
    getPlatform: () => mocks.platform,
  },
  registerPlugin: mocks.registerPlugin,
}));

beforeEach(() => {
  mocks.platform = 'web';
  mocks.registerPlugin.mockClear();
  vi.resetModules();
});

it('does not register the native bridge when the module loads or web calls no-op', async () => {
  const watch = await import('../watch-auth');
  expect(mocks.registerPlugin).not.toHaveBeenCalled();
  await watch.saveTokenToWatch('token');
  await watch.clearWatchToken();
  expect(mocks.registerPlugin).not.toHaveBeenCalled();
});

it('registers the native bridge lazily and reuses it on iOS', async () => {
  mocks.platform = 'ios';
  const watch = await import('../watch-auth');
  await watch.saveTokenToWatch('token');
  await watch.clearWatchToken();
  expect(mocks.registerPlugin).toHaveBeenCalledTimes(1);
  expect(mocks.registerPlugin).toHaveBeenCalledWith('WatchAuthBridge');
});

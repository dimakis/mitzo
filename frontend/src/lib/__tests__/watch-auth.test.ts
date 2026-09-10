import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: 'web',
  saveToken: vi.fn().mockResolvedValue(undefined),
  clearToken: vi.fn().mockResolvedValue(undefined),
  registerPlugin: vi.fn(),
}));
mocks.registerPlugin.mockImplementation(() => ({
  saveToken: mocks.saveToken,
  clearToken: mocks.clearToken,
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
  mocks.saveToken.mockReset().mockResolvedValue(undefined);
  mocks.clearToken.mockReset().mockResolvedValue(undefined);
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

it('serializes watch mutations so a later clear wins over an in-flight save', async () => {
  mocks.platform = 'ios';
  let finishSave!: () => void;
  mocks.saveToken.mockReturnValue(
    new Promise<void>((resolve) => {
      finishSave = resolve;
    }),
  );
  const watch = await import('../watch-auth');

  const save = watch.saveTokenToWatch('stale-token');
  await vi.waitFor(() => expect(mocks.saveToken).toHaveBeenCalled());
  const clear = watch.clearWatchToken();
  await Promise.resolve();
  expect(mocks.clearToken).not.toHaveBeenCalled();

  finishSave();
  await Promise.all([save, clear]);
  expect(mocks.clearToken).toHaveBeenCalledOnce();
});

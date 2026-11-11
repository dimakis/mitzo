// Synthetic OS bridge. The real client adapter, Login page and auth latch are used.
const params = new URLSearchParams(location.search);
export const Capacitor = {
  isNativePlatform: () => params.get('native') === '1',
  getPlatform: () => 'ios',
  isPluginAvailable: () => params.get('plugin') !== 'missing',
};
export function registerPlugin(name: string) {
  if (name === 'AppleSignInBridge')
    return {
      authorize: async ({ state }: { state: string }) => {
        if (params.get('cancel') === '1') throw { code: 'APPLE_CANCELLED' };
        return { state, code: 'synthetic-apple-code' };
      },
    };
  return new Proxy({}, { get: () => async () => undefined });
}
export class WebPlugin {}
export const AccessControl = { BIOMETRY_CURRENT_SET: 1 };
export const BiometryType = { FACE_ID: 2, TOUCH_ID: 1 };
export const NativeBiometric = { isAvailable: async () => ({ isAvailable: false }) };

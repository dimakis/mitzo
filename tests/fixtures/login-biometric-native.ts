// Synthetic native bridge for the offline login fixture; no device storage or models.
export const calls = { protectedWrites: [] as unknown[], identityPrompts: 0 };
Object.assign(window, { biometricFixture: calls });
export const Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
export function registerPlugin() {
  return new Proxy({}, { get: () => async () => undefined });
}
export class WebPlugin {}
export const AccessControl = { BIOMETRY_CURRENT_SET: 1 };
export const BiometryType = { FACE_ID: 2, TOUCH_ID: 1 };
export const NativeBiometric = {
  isAvailable: async () => ({ isAvailable: true, biometryType: 2 }),
  getSecureData: async () => {
    throw { code: '21' };
  },
  verifyIdentity: async () => {
    calls.identityPrompts++;
  },
  getCredentials: async () => {
    throw new Error('No legacy JWT in fixture');
  },
  setData: async (options: unknown) => {
    calls.protectedWrites.push(options);
  },
  setCredentials: async () => undefined,
  deleteCredentials: async () => undefined,
  deleteData: async () => undefined,
};

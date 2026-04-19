// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn() },
}));

vi.mock('@capgo/capacitor-native-biometric', () => ({
  NativeBiometric: {
    isAvailable: vi.fn(),
    verifyIdentity: vi.fn(),
    getCredentials: vi.fn(),
    setCredentials: vi.fn(),
    deleteCredentials: vi.fn(),
  },
  BiometryType: {
    NONE: 0,
    TOUCH_ID: 1,
    FACE_ID: 2,
    FINGERPRINT: 3,
    FACE_AUTHENTICATION: 4,
    IRIS_AUTHENTICATION: 5,
    MULTIPLE: 6,
    DEVICE_CREDENTIAL: 7,
  },
}));

import { Capacitor } from '@capacitor/core';
import { NativeBiometric } from '@capgo/capacitor-native-biometric';
import {
  isBiometricAvailable,
  biometricLogin,
  saveCredentials,
  deleteCredentials,
} from '../biometric';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('isBiometricAvailable', () => {
  it('returns false in browser', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(await isBiometricAvailable()).toBe(false);
  });

  it('returns true when native biometric is available', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.isAvailable).mockResolvedValue({
      isAvailable: true,
      biometryType: 2,
      errorCode: 0,
      strongBiometryIsAvailable: true,
      deviceIsSecure: true,
      authenticationStrength: 'strong',
    } as never);
    expect(await isBiometricAvailable()).toBe(true);
  });

  it('returns false when plugin throws', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.isAvailable).mockRejectedValue(new Error('fail'));
    expect(await isBiometricAvailable()).toBe(false);
  });
});

describe('saveCredentials', () => {
  it('no-ops in browser', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await saveCredentials('test-token');
    expect(NativeBiometric.setCredentials).not.toHaveBeenCalled();
  });

  it('stores token in keychain on native', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await saveCredentials('jwt-123');
    expect(NativeBiometric.setCredentials).toHaveBeenCalledWith({
      username: 'mitzo-user',
      password: 'jwt-123',
      server: 'com.mitzo.app',
    });
  });
});

describe('deleteCredentials', () => {
  it('no-ops in browser', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await deleteCredentials();
    expect(NativeBiometric.deleteCredentials).not.toHaveBeenCalled();
  });
});

describe('biometricLogin', () => {
  it('returns null in browser', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(await biometricLogin()).toBeNull();
  });

  it('returns token after successful biometric verification', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.verifyIdentity).mockResolvedValue(undefined as never);
    vi.mocked(NativeBiometric.getCredentials).mockResolvedValue({
      username: 'mitzo-user',
      password: 'stored-jwt',
    });

    const token = await biometricLogin();
    expect(token).toBe('stored-jwt');
    expect(localStorage.getItem('mitzo_auth_token')).toBe('stored-jwt');
  });

  it('returns null when verification fails', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.verifyIdentity).mockRejectedValue(new Error('cancelled'));

    expect(await biometricLogin()).toBeNull();
  });
});

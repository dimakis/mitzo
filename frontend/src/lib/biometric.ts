import { Capacitor } from '@capacitor/core';
import { NativeBiometric, BiometryType } from '@capgo/capacitor-native-biometric';

const SERVER = 'com.mitzo.app';
const AUTH_TOKEN_KEY = 'mitzo_auth_token';

export async function isBiometricAvailable(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const result = await NativeBiometric.isAvailable();
    return result.isAvailable;
  } catch {
    return false;
  }
}

export function biometryLabel(type: BiometryType): string {
  switch (type) {
    case BiometryType.FACE_ID:
      return 'Face ID';
    case BiometryType.TOUCH_ID:
      return 'Touch ID';
    case BiometryType.FINGERPRINT:
      return 'Fingerprint';
    case BiometryType.FACE_AUTHENTICATION:
      return 'Face Authentication';
    case BiometryType.IRIS_AUTHENTICATION:
      return 'Iris';
    default:
      return 'Biometric';
  }
}

/** Store JWT in Keychain after successful passphrase login. */
export async function saveCredentials(token: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await NativeBiometric.setCredentials({
      username: 'mitzo-user',
      password: token,
      server: SERVER,
    });
  } catch {
    // Keychain write failed — fall back to localStorage only
  }
}

/** Remove stored credentials (logout). */
export async function deleteCredentials(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await NativeBiometric.deleteCredentials({ server: SERVER });
  } catch {
    // No credentials to delete
  }
}

/**
 * Attempt biometric login: prompt Face ID / Touch ID, retrieve JWT from Keychain,
 * store in localStorage for apiFetch, and return the token.
 * Returns null if biometric auth fails or no credentials stored.
 */
export async function biometricLogin(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;

  try {
    await NativeBiometric.verifyIdentity({
      reason: 'Unlock Mitzo',
      title: 'Mitzo',
      subtitle: 'Authenticate to continue',
      useFallback: true,
    });

    const credentials = await NativeBiometric.getCredentials({
      server: SERVER,
    });
    const token = credentials.password;

    if (token) {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
      return token;
    }
    return null;
  } catch {
    return null;
  }
}

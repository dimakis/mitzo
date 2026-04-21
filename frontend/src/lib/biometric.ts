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

/** Return a user-facing label for the device's biometric type (e.g. "Face ID", "Touch ID"). */
export async function getBiometricLabel(): Promise<string> {
  if (!Capacitor.isNativePlatform()) return 'Biometric';
  try {
    const result = await NativeBiometric.isAvailable();
    return biometryLabel(result.biometryType);
  } catch {
    return 'Biometric';
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
 * validate with server, store in localStorage for apiFetch, and return the token.
 * Returns null if biometric auth fails, no credentials stored, or token is expired.
 */
export async function biometricLogin(apiBaseUrl = ''): Promise<string | null> {
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

    if (!token) return null;

    // Validate the token with the server before accepting it
    const res = await fetch(`${apiBaseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      // Token expired or invalid — clear stale credentials
      await deleteCredentials();
      localStorage.removeItem(AUTH_TOKEN_KEY);
      return null;
    }

    localStorage.setItem(AUTH_TOKEN_KEY, token);
    return token;
  } catch {
    return null;
  }
}
